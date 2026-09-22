import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  AuctionHoldNotFoundError,
  AuctionHoldReferenceError,
  AuctionHoldStateError,
} from '../../src/application/errors/AuctionHoldError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresAuctionHoldRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionHoldRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('PostgresAuctionHoldRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let holds: PostgresAuctionHoldRepository
  const now = new Date('2026-09-22T15:00:00.000Z')
  const close = new Date('2026-09-22T16:00:00.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined)
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    holds = new PostgresAuctionHoldRepository(db)
  }, 120_000)
  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seed = async (id: string, balance: number): Promise<void> => {
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${id},${balance},0,'2026-09-21')`.execute(
      db,
    )
  }
  const row = async (id: string) =>
    (
      await sql<{
        balance: string
        reserved: string
      }>`select balance,reserved from wallet_accounts where player_id=${id}`.execute(db)
    ).rows[0]
  const create = (operationId: string, playerId: string, amount = 30) =>
    holds.create({
      operationId,
      playerId,
      amount,
      auctionId: `auction-${operationId}`,
      bidId: `bid-${operationId}`,
      closesAt: close,
      now,
      graceMs: 300_000,
    })

  it('migration 003 creates Auction tables and enforces its constraints', async () => {
    const tables = await sql<{
      table_name: string
    }>`select table_name from information_schema.tables where table_name in ('wallet_auction_holds','wallet_auction_hold_operations','wallet_auction_hold_ledger')`.execute(
      db,
    )
    expect(tables.rows).toHaveLength(3)
    await expect(
      sql`insert into wallet_auction_holds (id,creation_operation_id,player_id,amount,auction_id,bid_id,reason,status,created_at,updated_at,expires_at) values ('bad','bad','p',0,'a','b','AUCTION_BID','ACTIVE',${now},${now},${close})`.execute(
        db,
      ),
    ).rejects.toThrow()
    await expect(
      sql`insert into wallet_auction_holds (id,creation_operation_id,player_id,amount,auction_id,bid_id,reason,status,created_at,updated_at,expires_at) values ('bad-status','bad-status','p',1,'a','b','AUCTION_BID','BROKEN',${now},${now},${close})`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('reserve preserves balance, records hold/operation/ledger and has durable replay/conflict', async () => {
    await seed('auction-reserve', 100)
    const first = await create('reserve-pg', 'auction-reserve')
    expect(first).toMatchObject({ applied: true, holdStatus: 'ACTIVE' })
    expect(await row('auction-reserve')).toEqual({ balance: '100', reserved: '30' })
    const stored =
      await sql`select * from wallet_auction_hold_ledger where operation_id='reserve-pg'`.execute(
        db,
      )
    expect(stored.rows).toHaveLength(1)
    const replay = await new PostgresAuctionHoldRepository(db).create({
      operationId: 'reserve-pg',
      playerId: 'auction-reserve',
      amount: 30,
      auctionId: 'auction-reserve-pg',
      bidId: 'bid-reserve-pg',
      closesAt: close,
      now,
      graceMs: 300_000,
    })
    expect(replay).toEqual({ ...first, applied: false })
    await expect(create('reserve-pg', 'auction-reserve', 31)).rejects.toThrow(
      OperationConflictError,
    )
  })

  it('insufficient reserve rolls back every Auction row', async () => {
    await seed('auction-insufficient', 10)
    await expect(create('reserve-insufficient', 'auction-insufficient')).rejects.toThrow()
    expect(await row('auction-insufficient')).toEqual({ balance: '10', reserved: '0' })
    expect(
      (await sql`select 1 from wallet_auction_holds where id='reserve-insufficient'`.execute(db))
        .rows,
    ).toHaveLength(0)
  })

  it('capture uses the persisted amount, conserves balances and replays exactly once', async () => {
    await seed('auction-winner', 100)
    await seed('auction-seller', 20)
    await create('capture-hold', 'auction-winner')
    const first = await holds.capture({
      operationId: 'capture-op',
      holdId: 'capture-hold',
      beneficiaryPlayerId: 'auction-seller',
      auctionId: 'auction-capture-hold',
      winningBidId: 'bid-capture-hold',
      now,
    })
    expect(first).toMatchObject({ applied: true, holdStatus: 'CAPTURED' })
    expect(await row('auction-winner')).toEqual({ balance: '70', reserved: '0' })
    expect(await row('auction-seller')).toEqual({ balance: '50', reserved: '0' })
    expect(
      (
        await sql`select * from wallet_auction_hold_ledger where operation_id='capture-op'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(2)
    expect(
      await holds.capture({
        operationId: 'capture-op',
        holdId: 'capture-hold',
        beneficiaryPlayerId: 'auction-seller',
        auctionId: 'auction-capture-hold',
        winningBidId: 'bid-capture-hold',
        now,
      }),
    ).toEqual({ ...first, applied: false })
    await expect(
      holds.capture({
        operationId: 'capture-op',
        holdId: 'capture-hold',
        beneficiaryPlayerId: 'other',
        auctionId: 'auction-capture-hold',
        winningBidId: 'bid-capture-hold',
        now,
      }),
    ).rejects.toThrow(OperationConflictError)
  })

  it('rejects missing, mismatched and terminal holds', async () => {
    await expect(
      holds.capture({
        operationId: 'missing-capture',
        holdId: 'none',
        beneficiaryPlayerId: 'x',
        auctionId: 'a',
        winningBidId: 'b',
        now,
      }),
    ).rejects.toThrow(AuctionHoldNotFoundError)
    await seed('auction-reference', 100)
    await create('reference-hold', 'auction-reference')
    await expect(
      holds.capture({
        operationId: 'reference-op',
        holdId: 'reference-hold',
        beneficiaryPlayerId: 'x',
        auctionId: 'wrong',
        winningBidId: 'bid-reference-hold',
        now,
      }),
    ).rejects.toThrow(AuctionHoldReferenceError)
    await holds.release({
      operationId: 'reference-release',
      holdId: 'reference-hold',
      reason: 'AUCTION_OUTBID',
      now,
    })
    await expect(
      holds.capture({
        operationId: 'reference-capture',
        holdId: 'reference-hold',
        beneficiaryPlayerId: 'x',
        auctionId: 'auction-reference-hold',
        winningBidId: 'bid-reference-hold',
        now,
      }),
    ).rejects.toThrow(AuctionHoldStateError)
  })

  it('release and expiry only lower reserved and are idempotent by state', async () => {
    await seed('auction-release', 100)
    await create('release-hold', 'auction-release')
    const released = await holds.release({
      operationId: 'release-op',
      holdId: 'release-hold',
      reason: 'AUCTION_OUTBID',
      now,
    })
    expect(released.applied).toBe(true)
    expect(await row('auction-release')).toEqual({ balance: '100', reserved: '0' })
    expect(
      await holds.release({
        operationId: 'release-op',
        holdId: 'release-hold',
        reason: 'AUCTION_OUTBID',
        now,
      }),
    ).toEqual({ ...released, applied: false })
    await seed('auction-expire', 100)
    await holds.create({
      operationId: 'expire-hold',
      playerId: 'auction-expire',
      amount: 30,
      auctionId: 'auction-expire',
      bidId: 'bid-expire',
      closesAt: new Date(now.getTime() - 600_000),
      now: new Date(now.getTime() - 900_000),
      graceMs: 1,
    })
    expect(await holds.expire(now)).toBeGreaterThanOrEqual(1)
    expect(await row('auction-expire')).toEqual({ balance: '100', reserved: '0' })
    expect(await holds.expire(now)).toBe(0)
  })

  it('concurrent captures transfer only once', async () => {
    await seed('auction-race-winner', 100)
    await seed('auction-race-seller', 20)
    await create('race-hold', 'auction-race-winner')
    const input = {
      holdId: 'race-hold',
      beneficiaryPlayerId: 'auction-race-seller',
      auctionId: 'auction-race-hold',
      winningBidId: 'bid-race-hold',
      now,
    }
    const results = await Promise.allSettled([
      holds.capture({ ...input, operationId: 'race-op' }),
      new PostgresAuctionHoldRepository(db).capture({ ...input, operationId: 'race-op' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(await row('auction-race-winner')).toEqual({ balance: '70', reserved: '0' })
    expect(await row('auction-race-seller')).toEqual({ balance: '50', reserved: '0' })
  })
})
