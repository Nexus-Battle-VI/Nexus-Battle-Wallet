import { startTestPostgres } from '../support/postgres'
import { sql, type Kysely } from 'kysely'

import { TournamentEntryFeeNotFoundError } from '../../src/application/errors/TournamentEntryFeeError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresTournamentEntryFeeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEntryFeeRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('PostgresTournamentEntryFeeRepository', () => {
  let container: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let fees: PostgresTournamentEntryFeeRepository
  const now = new Date('2026-09-24T15:00:00.000Z')

  beforeAll(async () => {
    container = await startTestPostgres()
    db = createDatabase({ connectionString: container.connectionString })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error) throw new Error('La migracion fallo.')
    fees = new PostgresTournamentEntryFeeRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seed = async (id: string, balance: number, reserved = 0): Promise<void> => {
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${id},${balance},${reserved},'2026-09-21')`.execute(
      db,
    )
  }
  const account = async (id: string) =>
    (
      await sql<{
        balance: string
        reserved: string
      }>`select balance,reserved from wallet_accounts where player_id=${id}`.execute(db)
    ).rows[0]
  const charge = (operationId: string, payerId: string, amount = 30) =>
    fees.charge({ operationId, payerId, tournamentId: 'T1', teamId: 'team1', amount, now })

  it('rechazo durable, ledger único y replay después de devolución', async () => {
    await seed('hu84-db', 99)
    expect((await charge('hu84-reject', 'hu84-db', 100)).status).toBe('REJECTED')
    await sql`UPDATE wallet_accounts SET balance=120 WHERE player_id='hu84-db'`.execute(db)
    fees = new PostgresTournamentEntryFeeRepository(db)
    expect((await charge('hu84-reject', 'hu84-db', 100)).status).toBe('REJECTED')
    expect(await account('hu84-db')).toMatchObject({ balance: '120' })
    await Promise.all([
      charge('hu84-charge', 'hu84-db', 100),
      charge('hu84-charge', 'hu84-db', 100),
    ])
    expect(await account('hu84-db')).toMatchObject({ balance: '20' })
    await Promise.all([
      fees.refund({ operationId: 'hu84-refund', chargeId: 'hu84-charge', now }),
      fees.refund({ operationId: 'hu84-refund', chargeId: 'hu84-charge', now }),
    ])
    expect((await charge('hu84-charge', 'hu84-db', 100)).status).toBe('REFUNDED')
    expect(await account('hu84-db')).toMatchObject({ balance: '120' })
    const ledger = await db
      .selectFrom('wallet_tournament_entry_ledger')
      .selectAll()
      .where('charge_id', '=', 'hu84-charge')
      .execute()
    expect(ledger.map((x) => x.kind).sort()).toEqual(['CHARGE', 'REFUND'])
  })

  it('migration 008 creates fee and refund tables with the required constraints and indexes', async () => {
    const tables = await sql<{
      table_name: string
    }>`select table_name from information_schema.tables where table_name in ('wallet_tournament_entry_fees','wallet_tournament_entry_fee_refunds')`.execute(
      db,
    )
    expect(tables.rows).toHaveLength(2)
    const columns = await sql<{
      table_name: string
      column_name: string
    }>`select table_name,column_name from information_schema.columns where table_name in ('wallet_tournament_entry_fees','wallet_tournament_entry_fee_refunds')`.execute(
      db,
    )
    expect(columns.rows).not.toContainEqual({
      table_name: 'wallet_tournament_entry_fees',
      column_name: 'refund_operation_id',
    })
    const indexes = await sql<{
      indexname: string
    }>`select indexname from pg_indexes where tablename in ('wallet_tournament_entry_fees','wallet_tournament_entry_fee_refunds')`.execute(
      db,
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'wallet_tournament_entry_fees_pkey',
        'wallet_tournament_entry_fees_operation_id_key',
        'wallet_tournament_entry_fee_refunds_pkey',
        'wallet_entry_fee_refunds_charge_idx',
        'wallet_entry_fee_payer_status_idx',
      ]),
    )
    await expect(
      sql`insert into wallet_tournament_entry_fees (charge_id,operation_id,tournament_id,team_id,payer_id,amount,status,created_at) values ('bad','bad','T1','team1','seller',0,'CHARGED',${now})`.execute(
        db,
      ),
    ).rejects.toMatchObject({ constraint: 'wallet_entry_fee_amount_positive' })
    await expect(
      sql`insert into wallet_tournament_entry_fees (charge_id,operation_id,tournament_id,team_id,payer_id,amount,status,created_at) values ('bad-status','bad-status','T1','team1','seller',1,'BROKEN',${now})`.execute(
        db,
      ),
    ).rejects.toMatchObject({ constraint: 'wallet_entry_fee_status_valid' })
    await expect(
      sql`insert into wallet_tournament_entry_fee_refunds (operation_id,charge_id,created_at) values ('bad-refund','missing',${now})`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('charges once, replays safely, and rejects conflicting charge intents', async () => {
    await seed('fee-charge', 100)
    const first = await charge('charge-A', 'fee-charge')
    expect(first).toMatchObject({ chargeId: 'charge-A', status: 'CHARGED', applied: true })
    expect(await account('fee-charge')).toEqual({ balance: '70', reserved: '0' })
    expect(await charge('charge-A', 'fee-charge')).toEqual({ ...first, applied: false })
    await expect(charge('charge-A', 'other-seller')).rejects.toBeInstanceOf(OperationConflictError)
    await expect(charge('charge-A', 'fee-charge', 31)).rejects.toBeInstanceOf(
      OperationConflictError,
    )
    expect(await account('fee-charge')).toEqual({ balance: '70', reserved: '0' })
  })

  it('rejects a charge when the available balance is insufficient', async () => {
    await seed('fee-reserved', 100, 80)
    await expect(charge('charge-reserved', 'fee-reserved', 30)).resolves.toMatchObject({
      status: 'REJECTED',
      applied: false,
    })
    expect(await account('fee-reserved')).toEqual({ balance: '100', reserved: '80' })
  })

  it('refunds once, records every refund operation globally, and detects cross-charge reuse', async () => {
    await seed('fee-refund', 100)
    await charge('charge-refund-A', 'fee-refund', 30)
    const first = await fees.refund({ operationId: 'op-r1', chargeId: 'charge-refund-A', now })
    expect(first).toMatchObject({ status: 'REFUNDED', applied: true })
    expect(await account('fee-refund')).toEqual({ balance: '100', reserved: '0' })
    expect(await fees.refund({ operationId: 'op-r1', chargeId: 'charge-refund-A', now })).toEqual({
      ...first,
      applied: false,
    })
    expect(
      await fees.refund({ operationId: 'op-r2', chargeId: 'charge-refund-A', now }),
    ).toMatchObject({ applied: false, status: 'REFUNDED' })
    const ledger = await sql<{
      operation_id: string
      charge_id: string
    }>`select operation_id,charge_id from wallet_tournament_entry_fee_refunds where operation_id in ('op-r1','op-r2') order by operation_id`.execute(
      db,
    )
    expect(ledger.rows).toEqual([
      { operation_id: 'op-r1', charge_id: 'charge-refund-A' },
      { operation_id: 'op-r2', charge_id: 'charge-refund-A' },
    ])
    await charge('charge-refund-B', 'fee-refund', 20)
    await expect(
      fees.refund({ operationId: 'op-r2', chargeId: 'charge-refund-B', now }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })

  it('does not register an operation when refunding a missing charge', async () => {
    await expect(
      fees.refund({ operationId: 'missing-refund-op', chargeId: 'missing-charge', now }),
    ).rejects.toBeInstanceOf(TournamentEntryFeeNotFoundError)
    expect(
      (
        await sql`select * from wallet_tournament_entry_fee_refunds where operation_id='missing-refund-op'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0)
  })

  it('serializes concurrent charges so only one debit can apply', async () => {
    await seed('fee-charge-race', 10)
    const results = await Promise.allSettled([
      charge('charge-race-1', 'fee-charge-race', 7),
      new PostgresTournamentEntryFeeRepository(db).charge({
        operationId: 'charge-race-2',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'fee-charge-race',
        amount: 7,
        now,
      }),
    ])
    expect(
      results.filter(
        (result) => result.status === 'fulfilled' && result.value.status === 'CHARGED',
      ),
    ).toHaveLength(1)
    expect(
      results.filter(
        (result) => result.status === 'fulfilled' && result.value.status === 'REJECTED',
      ),
    ).toHaveLength(1)
    expect(await account('fee-charge-race')).toEqual({ balance: '3', reserved: '0' })
  })

  it('serializes concurrent refunds, credits once, and registers both operations', async () => {
    await seed('fee-refund-race', 10)
    await charge('charge-refund-race', 'fee-refund-race', 7)
    const results = await Promise.all([
      fees.refund({ operationId: 'race-r1', chargeId: 'charge-refund-race', now }),
      new PostgresTournamentEntryFeeRepository(db).refund({
        operationId: 'race-r2',
        chargeId: 'charge-refund-race',
        now,
      }),
    ])
    expect(results.map((result) => result.applied).sort()).toEqual([false, true])
    expect(await account('fee-refund-race')).toEqual({ balance: '10', reserved: '0' })
    expect(
      (
        await sql`select operation_id from wallet_tournament_entry_fee_refunds where charge_id='charge-refund-race'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(2)
  })

  it('conserva medios créditos en saldo y ledger y nunca toma reserved', async () => {
    await seed('half-balance', 120.5, 20)
    await charge('half-balance-charge', 'half-balance', 100)
    expect(await account('half-balance')).toEqual({ balance: '20.5', reserved: '20' })
    await fees.refund({ operationId: 'half-balance-refund', chargeId: 'half-balance-charge', now })
    expect(await account('half-balance')).toEqual({ balance: '120.5', reserved: '20' })
    const ledger = await db
      .selectFrom('wallet_tournament_entry_ledger')
      .select(['kind', 'resulting_balance'])
      .where('charge_id', '=', 'half-balance-charge')
      .orderBy('kind')
      .execute()
    expect(ledger).toEqual([
      { kind: 'CHARGE', resulting_balance: '20.5' },
      { kind: 'REFUND', resulting_balance: '120.5' },
    ])
  })

  it('hace aritmética exacta incluso cuando el saldo numeric no cabe en Number', async () => {
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values ('large-balance',9007199254740991.5,0,'2026-W39')`.execute(
      db,
    )
    await charge('large-balance-charge', 'large-balance', 1)
    expect(await account('large-balance')).toEqual({ balance: '9007199254740990.5', reserved: '0' })
    await fees.refund({
      operationId: 'large-balance-refund',
      chargeId: 'large-balance-charge',
      now,
    })
    expect(await account('large-balance')).toEqual({ balance: '9007199254740991.5', reserved: '0' })
    const ledger = await db
      .selectFrom('wallet_tournament_entry_ledger')
      .select('resulting_balance')
      .where('charge_id', '=', 'large-balance-charge')
      .orderBy('kind')
      .execute()
    expect(ledger.map((row) => row.resulting_balance)).toEqual([
      '9007199254740990.5',
      '9007199254740991.5',
    ])
  })

  it.each([{ tournamentId: 'T2' }, { teamId: 'team2' }, { payerId: 'other' }, { amount: 11 }])(
    'detecta toda la intención cambiada %j',
    async (changed) => {
      const operationId = `tuple-${Object.keys(changed)[0]!}`
      await seed(operationId, 120)
      const input = {
        operationId,
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: operationId,
        amount: 10,
        now,
      }
      await fees.charge(input)
      await expect(fees.charge({ ...input, ...changed })).rejects.toBeInstanceOf(
        OperationConflictError,
      )
      expect(await account(operationId)).toEqual({ balance: '110', reserved: '0' })
    },
  )

  it('rechaza cambiar el tipo de operación, también tras un rechazo sin ledger', async () => {
    await seed('cross-kind-payer', 120)
    await charge('cross-kind-charge', 'cross-kind-payer', 10)
    await expect(
      fees.refund({ operationId: 'cross-kind-charge', chargeId: 'cross-kind-charge', now }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await fees.refund({ operationId: 'cross-kind-refund', chargeId: 'cross-kind-charge', now })
    await expect(charge('cross-kind-refund', 'cross-kind-payer', 10)).rejects.toBeInstanceOf(
      OperationConflictError,
    )
    expect((await charge('cross-kind-rejected', 'missing-payer', 100)).status).toBe('REJECTED')
    await expect(
      fees.refund({ operationId: 'cross-kind-rejected', chargeId: 'cross-kind-charge', now }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    expect(await account('cross-kind-payer')).toEqual({ balance: '120', reserved: '0' })
  })

  it('serializa el mismo cobro desde pools independientes y rechaza otra intención', async () => {
    await seed('independent-pools', 120)
    const otherDb = createDatabase({ connectionString: container.connectionString })
    try {
      const otherFees = new PostgresTournamentEntryFeeRepository(otherDb)
      const input = {
        operationId: 'independent-charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'independent-pools',
        amount: 100,
        now,
      }
      const results = await Promise.all([fees.charge(input), otherFees.charge(input)])
      expect(results.map((result) => result.applied).sort()).toEqual([false, true])
      await expect(
        otherFees.charge({ ...input, teamId: 'conflicting-team' }),
      ).rejects.toBeInstanceOf(OperationConflictError)
      const refunds = await Promise.all([
        fees.refund({ operationId: 'independent-r1', chargeId: input.operationId, now }),
        otherFees.refund({ operationId: 'independent-r2', chargeId: input.operationId, now }),
      ])
      expect(refunds.map((result) => result.applied).sort()).toEqual([false, true])
      expect(await account('independent-pools')).toEqual({ balance: '120', reserved: '0' })
      expect(
        await db
          .selectFrom('wallet_tournament_entry_ledger')
          .selectAll()
          .where('charge_id', '=', input.operationId)
          .execute(),
      ).toHaveLength(2)
    } finally {
      await otherDb.destroy()
    }
  })

  it('revierte saldo, cobro y devolución si falla insertar el movimiento', async () => {
    await seed('rollback-payer', 120)
    await sql`create function fail_test_entry_ledger() returns trigger language plpgsql as $$
      begin
        if new.operation_id in ('rollback-charge', 'rollback-refund') then
          raise exception 'Fallo de persistencia inducido por la prueba';
        end if;
        return new;
      end;
    $$`.execute(db)
    await sql`create trigger fail_test_entry_ledger before insert on wallet_tournament_entry_ledger for each row execute function fail_test_entry_ledger()`.execute(
      db,
    )
    try {
      await expect(charge('rollback-charge', 'rollback-payer', 100)).rejects.toThrow(
        'Fallo de persistencia',
      )
      expect(await account('rollback-payer')).toEqual({ balance: '120', reserved: '0' })
      expect(
        await db
          .selectFrom('wallet_tournament_entry_fees')
          .selectAll()
          .where('charge_id', '=', 'rollback-charge')
          .execute(),
      ).toHaveLength(0)
      await charge('rollback-valid-charge', 'rollback-payer', 100)
      await expect(
        fees.refund({ operationId: 'rollback-refund', chargeId: 'rollback-valid-charge', now }),
      ).rejects.toThrow('Fallo de persistencia')
      expect(await account('rollback-payer')).toEqual({ balance: '20', reserved: '0' })
      expect((await charge('rollback-valid-charge', 'rollback-payer', 100)).status).toBe('CHARGED')
      expect(
        await db
          .selectFrom('wallet_tournament_entry_fee_refunds')
          .selectAll()
          .where('operation_id', '=', 'rollback-refund')
          .execute(),
      ).toHaveLength(0)
    } finally {
      await sql`drop trigger fail_test_entry_ledger on wallet_tournament_entry_ledger`.execute(db)
      await sql`drop function fail_test_entry_ledger()`.execute(db)
    }
    await fees.refund({ operationId: 'rollback-refund', chargeId: 'rollback-valid-charge', now })
    expect(await account('rollback-payer')).toEqual({ balance: '120', reserved: '0' })
  })

  it('el motor impide un segundo movimiento para el mismo cobro/tipo', async () => {
    await seed('ledger-constraint-payer', 120)
    await charge('ledger-constraint-charge', 'ledger-constraint-payer', 100)
    await expect(
      sql`insert into wallet_tournament_entry_ledger (operation_id,charge_id,kind,amount,resulting_balance,created_at) values ('ledger-duplicate','ledger-constraint-charge','CHARGE',100,20,${now})`.execute(
        db,
      ),
    ).rejects.toMatchObject({ constraint: 'wallet_entry_ledger_charge_kind_unique' })
  })
})
