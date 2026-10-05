import { sql, type Kysely } from 'kysely'
import { startTestPostgres } from '../support/postgres'
import { down } from '../../src/adapters/outbound/persistence/migrations/008-wallet-tournament-entry-fees'
import { PostgresAuctionPublicationFeeRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionPublicationFeeRepository'
import { PostgresTournamentEntryFeeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEntryFeeRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

describe('Migración 008 sobre Wallet develop publicado', () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  const now = new Date('2026-10-05T12:00:00Z')
  const through007 = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '008'))

  beforeAll(async () => {
    postgres = await startTestPostgres()
    db = createDatabase({ connectionString: postgres.connectionString })
  })
  afterAll(async () => {
    await db.destroy()
    await postgres.stop()
  })

  const snapshotPublishedTables = async (): Promise<Record<string, unknown>> => {
    const tables = await sql<{
      table_name: string
    }>`select table_name from information_schema.tables
      where table_schema='public' and table_name like 'wallet_%' and table_name not like 'wallet_tournament_%'
      order by table_name`.execute(db)
    const snapshot: Record<string, unknown> = {}
    for (const { table_name: tableName } of tables.rows) {
      const data = await sql<{
        records: unknown
      }>`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as records from ${sql.id(tableName)} t`.execute(
        db,
      )
      snapshot[tableName] = data.rows[0]!.records
    }
    return snapshot
  }

  it('aplica solo 008, conserva tablas/datos/medios créditos y no la repite al reconectar', async () => {
    const before = await migrateToLatest(db, through007)
    expect(before.error).toBeUndefined()
    expect(before.applied).toEqual([
      '001-wallet-accounts',
      '002-wallet-stakes',
      '003-wallet-auction-holds',
      '004-wallet-buy-now-transfers',
      '005-wallet-auction-publication-fees',
      '006-wallet-mission-reward-credits',
      '007-wallet-auction-publication-fee-partial-refund',
    ])
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values ('upgrade-payer',101,20,'2026-W41')`.execute(
      db,
    )
    const auctions = new PostgresAuctionPublicationFeeRepository(db)
    await auctions.charge({
      operationId: 'legacy-auction-charge',
      sellerId: 'upgrade-payer',
      amount: 3,
      now,
    })
    await auctions.refund({
      operationId: 'legacy-auction-refund',
      chargeId: 'legacy-auction-charge',
      amount: 1.5,
      now,
    })
    await sql`insert into wallet_ledger (operation_id,player_id,battle_id,reason,credits_amount,victory_credits_amount,occurred_at,resulting_balance,resulting_victory_progress,resulting_weekly_chest_count,resulting_week_identity,chest_earned)
      values ('legacy-reward','upgrade-payer','legacy-battle','PARTICIPATION',10,0,${now},99.5,0,0,'2026-W41',false)`.execute(
      db,
    )
    const saved = await snapshotPublishedTables()
    expect(Object.keys(saved).length).toBeGreaterThanOrEqual(13)
    const upgrade = await migrateToLatest(db)
    expect(upgrade.error).toBeUndefined()
    expect(upgrade.applied).toEqual(['008-wallet-tournament-entry-fees'])
    expect(await snapshotPublishedTables()).toEqual(saved)
    expect(
      await db
        .selectFrom('wallet_accounts')
        .select(['balance', 'reserved'])
        .where('player_id', '=', 'upgrade-payer')
        .executeTakeFirstOrThrow(),
    ).toEqual({ balance: '99.5', reserved: '20' })
    const history = await sql<{
      name: string
    }>`select name from kysely_migration order by name`.execute(db)
    expect(history.rows.map((row) => row.name)).toEqual([
      ...before.applied,
      '008-wallet-tournament-entry-fees',
    ])

    await db.destroy()
    db = createDatabase({ connectionString: postgres.connectionString })
    expect(await migrateToLatest(db)).toEqual({ applied: [], error: undefined })
    expect(await snapshotPublishedTables()).toEqual(saved)
    const fees = new PostgresTournamentEntryFeeRepository(db)
    await fees.charge({
      operationId: 'upgrade-entry',
      tournamentId: 'T-upgrade',
      teamId: 'team-upgrade',
      payerId: 'upgrade-payer',
      amount: 70,
      now,
    })
    expect(
      (
        await db
          .selectFrom('wallet_accounts')
          .select('balance')
          .where('player_id', '=', 'upgrade-payer')
          .executeTakeFirstOrThrow()
      ).balance,
    ).toBe('29.5')
    await fees.refund({ operationId: 'upgrade-compensation', chargeId: 'upgrade-entry', now })
    expect(
      (
        await db
          .selectFrom('wallet_accounts')
          .select('balance')
          .where('player_id', '=', 'upgrade-payer')
          .executeTakeFirstOrThrow()
      ).balance,
    ).toBe('99.5')
    expect(
      await db
        .selectFrom('wallet_auction_publication_fee_refunds')
        .select('amount')
        .where('operation_id', '=', 'legacy-auction-refund')
        .executeTakeFirstOrThrow(),
    ).toEqual({ amount: '1.5' })
  })

  it('down elimina únicamente las tablas nuevas y conserva la 007 con sus datos', async () => {
    const saved = await snapshotPublishedTables()
    await down(db as unknown as Kysely<unknown>)
    expect(await snapshotPublishedTables()).toEqual(saved)
    const newTables =
      await sql`select table_name from information_schema.tables where table_schema='public' and table_name like 'wallet_tournament_%'`.execute(
        db,
      )
    expect(newTables.rows).toEqual([])
    const numeric = await sql<{
      data_type: string
    }>`select data_type from information_schema.columns where table_name='wallet_accounts' and column_name='balance'`.execute(
      db,
    )
    expect(numeric.rows).toEqual([{ data_type: 'numeric' }])
  })
})
