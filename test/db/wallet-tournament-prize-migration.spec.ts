import { sql, type Kysely } from 'kysely'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { PostgresTournamentEntryFeeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEntryFeeRepository'
import { PostgresTournamentPrizeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentPrizeRepository'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { startTestPostgres } from '../support/postgres'
import { qaTournamentPrize } from '../support/tournament-prize'

describe('Migración 009: actualización desde develop/inscripción', () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  const now = new Date('2026-10-05T19:00:00Z')
  const through008 = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '009'))
  const snapshot = async () => {
    const tables = await sql<{
      table_name: string
    }>`select table_name from information_schema.tables
      where table_schema='public' and table_name like 'wallet_%'
      and table_name not in ('wallet_tournament_operation_ids','wallet_tournament_prize_ledger') order by table_name`.execute(
      db,
    )
    const records: Record<string, unknown> = {}
    for (const { table_name } of tables.rows)
      records[table_name] = (
        await sql`select to_jsonb(t) as row from ${sql.id(table_name)} t order by to_jsonb(t)::text`.execute(
          db,
        )
      ).rows
    return records
  }
  beforeAll(async () => {
    postgres = await startTestPostgres()
    db = createDatabase({ connectionString: postgres.connectionString })
  })
  afterAll(async () => {
    await db.destroy()
    await postgres.stop()
  })
  it('no modifica ninguna tabla previa y reserva todos los ids históricos incluyendo rechazos', async () => {
    expect((await migrateToLatest(db, through008)).applied).toHaveLength(8)
    await sql`insert into wallet_accounts (player_id,balance,reserved,victory_progress,weekly_chest_count,week_identity)
      values ('qa-upgrade-player',100.5,20,7,2,'2026-W40')`.execute(db)
    await sql`insert into wallet_tournament_entry_fees (charge_id,operation_id,tournament_id,team_id,payer_id,amount,status,created_at,refunded_at)
      values ('qa-old-charge','qa-old-charge','qa-old-t','qa-old-team','qa-upgrade-player',100,'REFUNDED',${now},${now}),
      ('qa-old-rejected','qa-old-rejected','qa-old-t','qa-old-team','qa-upgrade-player',101,'REJECTED',${now},null)`.execute(
      db,
    )
    await sql`insert into wallet_tournament_entry_fee_refunds (operation_id,charge_id,created_at) values ('qa-old-refund','qa-old-charge',${now})`.execute(
      db,
    )
    await sql`insert into wallet_tournament_entry_ledger (operation_id,charge_id,kind,amount,resulting_balance,created_at)
      values ('qa-old-charge','qa-old-charge','CHARGE',100,0.5,${now}),('qa-old-refund','qa-old-charge','REFUND',100,100.5,${now})`.execute(
      db,
    )
    await sql`insert into wallet_auction_publication_fees (charge_id,operation_id,seller_id,amount,status,created_at,refunded_at)
      values ('qa-legacy-auction','qa-legacy-auction','qa-upgrade-player',3,'REFUNDED',${now},${now})`.execute(
      db,
    )
    await sql`insert into wallet_auction_publication_fee_refunds (operation_id,charge_id,amount,created_at)
      values ('qa-legacy-half-refund','qa-legacy-auction',1.5,${now})`.execute(db)
    const before = await snapshot()
    expect(await migrateToLatest(db)).toEqual({
      applied: ['009-wallet-tournament-prizes'],
      error: undefined,
    })
    expect(await snapshot()).toEqual(before)
    const registry = await db
      .selectFrom('wallet_tournament_operation_ids')
      .select(['operation_id', 'purpose'])
      .orderBy('operation_id')
      .execute()
    expect(registry).toEqual([
      { operation_id: 'qa-old-charge', purpose: 'ENTRY_CHARGE' },
      { operation_id: 'qa-old-refund', purpose: 'ENTRY_REFUND' },
      { operation_id: 'qa-old-rejected', purpose: 'ENTRY_CHARGE' },
    ])
    const prizes = new PostgresTournamentPrizeRepository(db)
    for (const { operation_id } of registry)
      await expect(
        prizes.credit({ ...qaTournamentPrize('upgrade'), operationId: operation_id }, now),
      ).rejects.toBeInstanceOf(OperationConflictError)
    const fees = new PostgresTournamentEntryFeeRepository(db)
    expect(
      (
        await fees.charge({
          operationId: 'qa-old-charge',
          tournamentId: 'qa-old-t',
          teamId: 'qa-old-team',
          payerId: 'qa-upgrade-player',
          amount: 100,
          now,
        })
      ).status,
    ).toBe('REFUNDED')
    expect(
      (await fees.refund({ operationId: 'qa-old-refund', chargeId: 'qa-old-charge', now })).applied,
    ).toBe(false)
    expect(await snapshot()).toEqual(before)
    await db.destroy()
    db = createDatabase({ connectionString: postgres.connectionString })
    expect((await migrateToLatest(db)).applied).toEqual([])
    expect(await snapshot()).toEqual(before)
  })
})
