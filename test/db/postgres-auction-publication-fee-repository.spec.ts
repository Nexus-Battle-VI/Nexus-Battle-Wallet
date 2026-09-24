import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
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
})
