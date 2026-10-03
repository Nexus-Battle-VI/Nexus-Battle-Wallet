import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
  AuctionPublicationFeeRefundExceedsChargeError,
} from '../../src/application/errors/AuctionPublicationFeeError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresAuctionPublicationFeeRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionPublicationFeeRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('PostgresAuctionPublicationFeeRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let fees: PostgresAuctionPublicationFeeRepository
  const now = new Date('2026-09-24T15:00:00.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error) throw new Error('La migracion fallo.')
    fees = new PostgresAuctionPublicationFeeRepository(db)
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
  const charge = (operationId: string, sellerId: string, amount = 30) =>
    fees.charge({ operationId, sellerId, amount, now })
  const refund = (operationId: string, chargeId: string, amount?: number) =>
    fees.refund({ operationId, chargeId, amount, now })

  it('migration 005 creates fee and refund tables with the required constraints and indexes', async () => {
    const tables = await sql<{
      table_name: string
    }>`select table_name from information_schema.tables where table_name in ('wallet_auction_publication_fees','wallet_auction_publication_fee_refunds')`.execute(
      db,
    )
    expect(tables.rows).toHaveLength(2)
    const columns = await sql<{
      table_name: string
      column_name: string
    }>`select table_name,column_name from information_schema.columns where table_name in ('wallet_auction_publication_fees','wallet_auction_publication_fee_refunds')`.execute(
      db,
    )
    expect(columns.rows).not.toContainEqual({
      table_name: 'wallet_auction_publication_fees',
      column_name: 'refund_operation_id',
    })
    const indexes = await sql<{
      indexname: string
    }>`select indexname from pg_indexes where tablename in ('wallet_auction_publication_fees','wallet_auction_publication_fee_refunds')`.execute(
      db,
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'wallet_auction_publication_fees_pkey',
        'wallet_auction_publication_fees_operation_id_key',
        'wallet_auction_publication_fee_refunds_pkey',
        'wallet_publication_fee_refunds_charge_idx',
        'wallet_publication_fee_seller_status_idx',
      ]),
    )
    await expect(
      sql`insert into wallet_auction_publication_fees (charge_id,operation_id,seller_id,amount,status,created_at) values ('bad','bad','seller',0,'CHARGED',${now})`.execute(
        db,
      ),
    ).rejects.toThrow()
    await expect(
      sql`insert into wallet_auction_publication_fees (charge_id,operation_id,seller_id,amount,status,created_at) values ('bad-status','bad-status','seller',1,'BROKEN',${now})`.execute(
        db,
      ),
    ).rejects.toThrow()
    await expect(
      sql`insert into wallet_auction_publication_fee_refunds (operation_id,charge_id,created_at) values ('bad-refund','missing',${now})`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('migration 007 moves balance/reserved/refund amount to numeric with the HU-90 constraints', async () => {
    const columns = await sql<{
      table_name: string
      column_name: string
      data_type: string
    }>`select table_name,column_name,data_type from information_schema.columns
       where (table_name='wallet_accounts' and column_name in ('balance','reserved'))
          or (table_name='wallet_ledger' and column_name='resulting_balance')
          or (table_name='wallet_auction_publication_fee_refunds' and column_name='amount')`.execute(
      db,
    )
    expect(columns.rows).toEqual(
      expect.arrayContaining([
        { table_name: 'wallet_accounts', column_name: 'balance', data_type: 'numeric' },
        { table_name: 'wallet_accounts', column_name: 'reserved', data_type: 'numeric' },
        { table_name: 'wallet_ledger', column_name: 'resulting_balance', data_type: 'numeric' },
        {
          table_name: 'wallet_auction_publication_fee_refunds',
          column_name: 'amount',
          data_type: 'numeric',
        },
      ]),
    )
    // balance admite medios creditos (0.5/1.5); reserved sigue restringido a enteros.
    await seed('fee-numeric-balance', 10)
    await sql`update wallet_accounts set balance=10.5 where player_id='fee-numeric-balance'`.execute(
      db,
    )
    expect(await account('fee-numeric-balance')).toEqual({ balance: '10.5', reserved: '0' })
    await expect(
      sql`update wallet_accounts set balance=10.3 where player_id='fee-numeric-balance'`.execute(
        db,
      ),
    ).rejects.toThrow()
    await expect(
      sql`update wallet_accounts set reserved=1.5 where player_id='fee-numeric-balance'`.execute(
        db,
      ),
    ).rejects.toThrow()
    await seed('fee-numeric-refund-amount', 10)
    await charge('charge-numeric-refund-amount', 'fee-numeric-refund-amount', 1)
    await expect(
      sql`insert into wallet_auction_publication_fee_refunds (operation_id,charge_id,amount,created_at) values ('bad-refund-amount','charge-numeric-refund-amount',0.25,${now})`.execute(
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
    await expect(charge('charge-reserved', 'fee-reserved', 30)).rejects.toBeInstanceOf(
      AuctionPublicationFeeInsufficientBalanceError,
    )
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
    }>`select operation_id,charge_id from wallet_auction_publication_fee_refunds where operation_id in ('op-r1','op-r2') order by operation_id`.execute(
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
    ).rejects.toBeInstanceOf(AuctionPublicationFeeNotFoundError)
    expect(
      (
        await sql`select * from wallet_auction_publication_fee_refunds where operation_id='missing-refund-op'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0)
  })

  it('serializes concurrent charges so only one debit can apply', async () => {
    await seed('fee-charge-race', 10)
    const results = await Promise.allSettled([
      charge('charge-race-1', 'fee-charge-race', 7),
      new PostgresAuctionPublicationFeeRepository(db).charge({
        operationId: 'charge-race-2',
        sellerId: 'fee-charge-race',
        amount: 7,
        now,
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await account('fee-charge-race')).toEqual({ balance: '3', reserved: '0' })
  })

  it('serializes concurrent refunds, credits once, and registers both operations', async () => {
    await seed('fee-refund-race', 10)
    await charge('charge-refund-race', 'fee-refund-race', 7)
    const results = await Promise.all([
      fees.refund({ operationId: 'race-r1', chargeId: 'charge-refund-race', now }),
      new PostgresAuctionPublicationFeeRepository(db).refund({
        operationId: 'race-r2',
        chargeId: 'charge-refund-race',
        now,
      }),
    ])
    expect(results.map((result) => result.applied).sort()).toEqual([false, true])
    expect(await account('fee-refund-race')).toEqual({ balance: '10', reserved: '0' })
    expect(
      (
        await sql`select operation_id from wallet_auction_publication_fee_refunds where charge_id='charge-refund-race'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(2)
  })

  // HU-90 (7.7.10): penalizacion del 50% de la comision de publicacion.
  it('refunds half a 1-credit fee: 9 -> 9.5, exact, no rounding', async () => {
    await seed('fee-half-24h', 9)
    await charge('charge-half-24h', 'fee-half-24h', 1)
    expect(await account('fee-half-24h')).toEqual({ balance: '8', reserved: '0' })
    const result = await refund('refund-half-24h', 'charge-half-24h', 0.5)
    expect(result).toMatchObject({ status: 'REFUNDED', applied: true, amount: 0.5 })
    expect(await account('fee-half-24h')).toEqual({ balance: '8.5', reserved: '0' })
  })

  it('refunds half a 3-credit fee: balance keeps the .5 through the ledger', async () => {
    await seed('fee-half-48h', 20)
    await charge('charge-half-48h', 'fee-half-48h', 3)
    const result = await refund('refund-half-48h', 'charge-half-48h', 1.5)
    expect(result).toMatchObject({ status: 'REFUNDED', applied: true, amount: 1.5 })
    expect(await account('fee-half-48h')).toEqual({ balance: '18.5', reserved: '0' })
    const stored = await sql<{
      amount: string
    }>`select amount from wallet_auction_publication_fee_refunds where operation_id='refund-half-48h'`.execute(
      db,
    )
    expect(stored.rows[0]?.amount).toBe('1.5')
  })

  it.each([[0], [-0.5], [0.25], [1.25]])(
    'rejects a refund amount that is not a positive multiple of 0.5 (%s)',
    async (amount) => {
      const id = String(amount).replace('.', '-').replace('-', 'neg-')
      await seed(`fee-half-invalid-${id}`, 10)
      await charge(`charge-half-invalid-${id}`, `fee-half-invalid-${id}`, 3)
      await expect(
        refund(`refund-half-invalid-${id}`, `charge-half-invalid-${id}`, amount),
      ).rejects.toThrow()
    },
  )

  it('rejects a refund amount greater than what was charged', async () => {
    await seed('fee-half-exceeds', 10)
    await charge('charge-half-exceeds', 'fee-half-exceeds', 1)
    await expect(refund('refund-half-exceeds', 'charge-half-exceeds', 1.5)).rejects.toBeInstanceOf(
      AuctionPublicationFeeRefundExceedsChargeError,
    )
    expect(await account('fee-half-exceeds')).toEqual({ balance: '9', reserved: '0' })
  })

  it('replays a partial refund idempotently and conflicts on a different amount, without double-crediting', async () => {
    await seed('fee-half-idem', 10)
    await charge('charge-half-idem', 'fee-half-idem', 3)
    const first = await refund('refund-half-idem', 'charge-half-idem', 1.5)
    expect(first).toMatchObject({ applied: true, amount: 1.5 })
    expect(await account('fee-half-idem')).toEqual({ balance: '8.5', reserved: '0' })
    const replay = await refund('refund-half-idem', 'charge-half-idem', 1.5)
    expect(replay).toMatchObject({ applied: false, amount: 1.5 })
    expect(await account('fee-half-idem')).toEqual({ balance: '8.5', reserved: '0' })
    await expect(refund('refund-half-idem', 'charge-half-idem', 1)).rejects.toBeInstanceOf(
      OperationConflictError,
    )
    // Un operationId distinto que intenta refundar una comision ya
    // refundada no se aplica dos veces: el invariante es un refund
    // aplicado por charge (`fee.status`), no una fila por refund.
    const second = await refund('refund-half-idem-2', 'charge-half-idem', 1.5)
    expect(second).toMatchObject({ applied: false, status: 'REFUNDED' })
    expect(await account('fee-half-idem')).toEqual({ balance: '8.5', reserved: '0' })
  })

  it('serializes concurrent partial refunds, credits the amount once, and registers both operations', async () => {
    await seed('fee-half-race', 10)
    await charge('charge-half-race', 'fee-half-race', 3)
    const results = await Promise.all([
      refund('race-half-r1', 'charge-half-race', 1.5),
      new PostgresAuctionPublicationFeeRepository(db).refund({
        operationId: 'race-half-r2',
        chargeId: 'charge-half-race',
        amount: 1.5,
        now,
      }),
    ])
    expect(results.map((result) => result.applied).sort()).toEqual([false, true])
    expect(await account('fee-half-race')).toEqual({ balance: '8.5', reserved: '0' })
  })

  it('leaves publication (1 and 3 credits) and a full refund without amount unaffected', async () => {
    await seed('fee-half-compat', 10)
    await charge('charge-half-compat-24h', 'fee-half-compat', 1)
    await charge('charge-half-compat-48h', 'fee-half-compat', 3)
    expect(await account('fee-half-compat')).toEqual({ balance: '6', reserved: '0' })
    await refund('refund-half-compat-24h', 'charge-half-compat-24h')
    await refund('refund-half-compat-48h', 'charge-half-compat-48h')
    expect(await account('fee-half-compat')).toEqual({ balance: '10', reserved: '0' })
  })
})
