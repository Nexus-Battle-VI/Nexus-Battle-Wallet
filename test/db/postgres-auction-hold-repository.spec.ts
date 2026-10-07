import { startTestPostgres } from '../support/postgres'
import { sql, type Kysely } from 'kysely'

import {
  AuctionHoldAlreadyCapturedError,
  AuctionHoldNotFoundError,
  AuctionHoldReferenceError,
  AuctionHoldStateError,
} from '../../src/application/errors/AuctionHoldError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresAuctionHoldRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionHoldRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('PostgresAuctionHoldRepository', () => {
  let container: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let holds: PostgresAuctionHoldRepository
  const now = new Date('2026-09-22T15:00:00.000Z')
  const close = new Date('2026-09-22T16:00:00.000Z')

  beforeAll(async () => {
    container = await startTestPostgres()
    db = createDatabase({ connectionString: container.connectionString })
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

  /**
   * HU-90 (CA-05): release al cancelar una subasta, contra PostgreSQL real.
   * Lo que solo se puede comprobar aqui es el ledger: un no-op no escribe
   * ningun movimiento y un replay no duplica el que ya existe.
   */
  describe('release por cancelacion de subasta (HU-90, CA-05)', () => {
    const releaseLedger = async (holdId: string) =>
      (
        await sql<{ operation_id: string; kind: string; amount: string }>`
          select operation_id, kind, amount from wallet_auction_hold_ledger
          where hold_id = ${holdId} and kind = 'AUCTION_HOLD_RELEASED'
        `.execute(db)
      ).rows
    const holdStatus = async (holdId: string) =>
      (
        await sql<{ status: string }>`
          select status from wallet_auction_holds where id = ${holdId}
        `.execute(db)
      ).rows[0]?.status
    const operations = async (operationId: string) =>
      (
        await sql<{ operation_id: string }>`
          select operation_id from wallet_auction_hold_operations
          where operation_id = ${operationId}
        `.execute(db)
      ).rows

    it('ACTIVE -> RELEASED con AUCTION_CANCELLED: un unico movimiento de ledger y reserved correcto', async () => {
      await seed('cancel-active', 100)
      await create('cancel-active-hold', 'cancel-active')
      // Una segunda reserva del mismo jugador no debe verse afectada.
      await create('cancel-active-other', 'cancel-active', 20)
      expect(await row('cancel-active')).toEqual({ balance: '100', reserved: '50' })

      const released = await holds.release({
        operationId: 'cancel-active-op',
        holdId: 'cancel-active-hold',
        reason: 'AUCTION_CANCELLED',
        now,
      })

      expect(released).toEqual({
        operationId: 'cancel-active-op',
        holdId: 'cancel-active-hold',
        holdStatus: 'RELEASED',
        applied: true,
      })
      expect(await holdStatus('cancel-active-hold')).toBe('RELEASED')
      expect(await row('cancel-active')).toEqual({ balance: '100', reserved: '20' })
      expect(await releaseLedger('cancel-active-hold')).toEqual([
        { operation_id: 'cancel-active-op', kind: 'AUCTION_HOLD_RELEASED', amount: '30' },
      ])
      const intent = await sql<{ intent: unknown }>`
        select intent from wallet_auction_hold_operations where operation_id = 'cancel-active-op'
      `.execute(db)
      expect(intent.rows[0]?.intent).toEqual(['release', 'cancel-active-hold', 'AUCTION_CANCELLED'])
    })

    it('el replay del mismo operationId no duplica ledger ni liberacion', async () => {
      await seed('cancel-replay', 100)
      await create('cancel-replay-hold', 'cancel-replay')
      const command = {
        operationId: 'cancel-replay-op',
        holdId: 'cancel-replay-hold',
        reason: 'AUCTION_CANCELLED',
        now,
      } as const
      const first = await holds.release(command)

      const replay = await new PostgresAuctionHoldRepository(db).release(command)

      expect(replay).toEqual({ ...first, applied: false })
      expect(await row('cancel-replay')).toEqual({ balance: '100', reserved: '0' })
      expect(await releaseLedger('cancel-replay-hold')).toHaveLength(1)
      expect(await operations('cancel-replay-op')).toHaveLength(1)
    })

    it('dos releases concurrentes del mismo hold con operationId distintos liberan una sola vez', async () => {
      await seed('cancel-race', 100)
      await create('cancel-race-hold', 'cancel-race')

      const results = await Promise.all([
        holds.release({
          operationId: 'cancel-race-op-a',
          holdId: 'cancel-race-hold',
          reason: 'AUCTION_CANCELLED',
          now,
        }),
        new PostgresAuctionHoldRepository(db).release({
          operationId: 'cancel-race-op-b',
          holdId: 'cancel-race-hold',
          reason: 'AUCTION_OUTBID',
          now,
        }),
      ])

      expect(results.map((result) => result.applied).sort()).toEqual([false, true])
      expect(results.every((result) => result.holdStatus === 'RELEASED')).toBe(true)
      expect(await row('cancel-race')).toEqual({ balance: '100', reserved: '0' })
      expect(await releaseLedger('cancel-race-hold')).toHaveLength(1)
    })

    it('RELEASED por otra operacion: no-op exitoso, sin ledger nuevo y con replay estable', async () => {
      await seed('cancel-released', 100)
      await create('cancel-released-hold', 'cancel-released')
      await holds.release({
        operationId: 'cancel-released-outbid',
        holdId: 'cancel-released-hold',
        reason: 'AUCTION_OUTBID',
        now,
      })
      const command = {
        operationId: 'cancel-released-op',
        holdId: 'cancel-released-hold',
        reason: 'AUCTION_CANCELLED',
        now,
      } as const

      const noop = await holds.release(command)

      expect(noop).toEqual({
        operationId: 'cancel-released-op',
        holdId: 'cancel-released-hold',
        holdStatus: 'RELEASED',
        applied: false,
      })
      expect(await holds.release(command)).toEqual(noop)
      expect(await row('cancel-released')).toEqual({ balance: '100', reserved: '0' })
      expect(await releaseLedger('cancel-released-hold')).toEqual([
        { operation_id: 'cancel-released-outbid', kind: 'AUCTION_HOLD_RELEASED', amount: '30' },
      ])
      expect(await operations('cancel-released-op')).toHaveLength(1)
    })

    it('EXPIRED: no-op exitoso con el estado real, sin ledger de release', async () => {
      await seed('cancel-expired', 100)
      await holds.create({
        operationId: 'cancel-expired-hold',
        playerId: 'cancel-expired',
        amount: 30,
        auctionId: 'auction-cancel-expired',
        bidId: 'bid-cancel-expired',
        closesAt: new Date(now.getTime() - 600_000),
        now: new Date(now.getTime() - 900_000),
        graceMs: 1,
      })
      expect(await holds.expire(now)).toBeGreaterThanOrEqual(1)
      expect(await holdStatus('cancel-expired-hold')).toBe('EXPIRED')

      const noop = await holds.release({
        operationId: 'cancel-expired-op',
        holdId: 'cancel-expired-hold',
        reason: 'AUCTION_CANCELLED',
        now,
      })

      expect(noop).toEqual({
        operationId: 'cancel-expired-op',
        holdId: 'cancel-expired-hold',
        holdStatus: 'EXPIRED',
        applied: false,
      })
      expect(await holdStatus('cancel-expired-hold')).toBe('EXPIRED')
      expect(await row('cancel-expired')).toEqual({ balance: '100', reserved: '0' })
      expect(await releaseLedger('cancel-expired-hold')).toEqual([])
    })

    it('CAPTURED: error distinguible, sin saldo, ledger ni operacion registrados', async () => {
      await seed('cancel-captured', 100)
      await seed('cancel-captured-seller', 0)
      await create('cancel-captured-hold', 'cancel-captured')
      await holds.capture({
        operationId: 'cancel-captured-capture',
        holdId: 'cancel-captured-hold',
        beneficiaryPlayerId: 'cancel-captured-seller',
        auctionId: 'auction-cancel-captured-hold',
        winningBidId: 'bid-cancel-captured-hold',
        now,
      })
      const command = {
        operationId: 'cancel-captured-op',
        holdId: 'cancel-captured-hold',
        reason: 'AUCTION_CANCELLED',
        now,
      } as const

      await expect(holds.release(command)).rejects.toThrow(AuctionHoldAlreadyCapturedError)
      // Reintentarlo no lo convierte en exito: no quedo ningun replay guardado.
      await expect(holds.release(command)).rejects.toThrow(AuctionHoldAlreadyCapturedError)

      expect(await holdStatus('cancel-captured-hold')).toBe('CAPTURED')
      expect(await row('cancel-captured')).toEqual({ balance: '70', reserved: '0' })
      expect(await row('cancel-captured-seller')).toEqual({ balance: '30', reserved: '0' })
      expect(await releaseLedger('cancel-captured-hold')).toEqual([])
      expect(await operations('cancel-captured-op')).toEqual([])
    })

    it('hold inexistente: AuctionHoldNotFoundError sin registrar la operacion', async () => {
      await expect(
        holds.release({
          operationId: 'cancel-missing-op',
          holdId: 'cancel-missing-hold',
          reason: 'AUCTION_CANCELLED',
          now,
        }),
      ).rejects.toThrow(AuctionHoldNotFoundError)
      expect(await operations('cancel-missing-op')).toEqual([])
    })

    it('mismo operationId con otro reason: conflicto de idempotencia, sin tocar el hold', async () => {
      await seed('cancel-conflict', 100)
      await create('cancel-conflict-hold', 'cancel-conflict')
      await holds.release({
        operationId: 'cancel-conflict-op',
        holdId: 'cancel-conflict-hold',
        reason: 'AUCTION_SETTLEMENT_LOST',
        now,
      })

      await expect(
        holds.release({
          operationId: 'cancel-conflict-op',
          holdId: 'cancel-conflict-hold',
          reason: 'AUCTION_CANCELLED',
          now,
        }),
      ).rejects.toThrow(OperationConflictError)
      expect(await releaseLedger('cancel-conflict-hold')).toHaveLength(1)
      expect(await row('cancel-conflict')).toEqual({ balance: '100', reserved: '0' })
    })
  })
})
