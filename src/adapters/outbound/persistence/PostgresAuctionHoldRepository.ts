import type { Kysely, Transaction } from 'kysely'
import {
  AuctionHoldInsufficientBalanceError,
  AuctionHoldNotFoundError,
  AuctionHoldReferenceError,
  AuctionHoldStateError,
} from '../../../application/errors/AuctionHoldError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  AuctionHoldRepositoryPort,
  AuctionHoldResult,
  CaptureAuctionHold,
  CreateAuctionHold,
  ReleaseAuctionHold,
} from '../../../application/ports/AuctionHoldRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import type { Database } from './schema'

type Tx = Transaction<Database>
export class PostgresAuctionHoldRepository implements AuctionHoldRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  create(command: CreateAuctionHold): Promise<AuctionHoldResult> {
    return this.db.transaction().execute(async (tx) => {
      const intent = [
        'create',
        command.playerId,
        command.amount,
        command.auctionId,
        command.bidId,
        command.closesAt.toISOString(),
      ]
      const replay = await this.replay(tx, command.operationId, intent)
      if (replay) return replay
      await lockByText(tx, command.playerId)
      const account = await this.account(tx, command.playerId, command.now)
      if (account.balance - account.reserved < command.amount)
        throw new AuctionHoldInsufficientBalanceError()
      const reserved = account.reserved + command.amount
      await tx
        .updateTable('wallet_accounts')
        .set({ reserved, updated_at: command.now })
        .where('player_id', '=', command.playerId)
        .execute()
      await tx
        .insertInto('wallet_auction_holds')
        .values({
          id: command.operationId,
          creation_operation_id: command.operationId,
          player_id: command.playerId,
          amount: command.amount,
          auction_id: command.auctionId,
          bid_id: command.bidId,
          reason: 'AUCTION_BID',
          status: 'ACTIVE',
          created_at: command.now,
          updated_at: command.now,
          expires_at: new Date(command.closesAt.getTime() + command.graceMs),
        })
        .execute()
      const result = {
        operationId: command.operationId,
        holdId: command.operationId,
        holdStatus: 'ACTIVE' as const,
        applied: true,
      }
      await this.persist(tx, command.operationId, intent, result, command.now)
      await this.ledger(
        tx,
        command.operationId,
        command.operationId,
        command.playerId,
        'AUCTION_HOLD_RESERVED',
        command.amount,
        account.balance,
        reserved,
        command.now,
      )
      return result
    })
  }
  capture(command: CaptureAuctionHold): Promise<AuctionHoldResult> {
    return this.db.transaction().execute(async (tx) => {
      const intent = [
        'capture',
        command.holdId,
        command.beneficiaryPlayerId,
        command.auctionId,
        command.winningBidId,
      ]
      const replay = await this.replay(tx, command.operationId, intent)
      if (replay) return replay
      const hold = await tx
        .selectFrom('wallet_auction_holds')
        .selectAll()
        .where('id', '=', command.holdId)
        .forUpdate()
        .executeTakeFirst()
      if (!hold) throw new AuctionHoldNotFoundError(command.holdId)
      if (hold.status !== 'ACTIVE') throw new AuctionHoldStateError()
      if (hold.auction_id !== command.auctionId || hold.bid_id !== command.winningBidId)
        throw new AuctionHoldReferenceError()
      for (const playerId of [hold.player_id, command.beneficiaryPlayerId].sort())
        await lockByText(tx, playerId)
      const winner = await this.account(tx, hold.player_id, command.now)
      const seller = await this.account(tx, command.beneficiaryPlayerId, command.now)
      const amount = Number(hold.amount),
        reserved = winner.reserved - amount,
        balance = winner.balance - amount,
        sellerBalance = seller.balance + amount
      await tx
        .updateTable('wallet_accounts')
        .set({ balance, reserved, updated_at: command.now })
        .where('player_id', '=', hold.player_id)
        .execute()
      await tx
        .updateTable('wallet_accounts')
        .set({ balance: sellerBalance, updated_at: command.now })
        .where('player_id', '=', command.beneficiaryPlayerId)
        .execute()
      await tx
        .updateTable('wallet_auction_holds')
        .set({ status: 'CAPTURED', updated_at: command.now })
        .where('id', '=', hold.id)
        .execute()
      const result = {
        operationId: command.operationId,
        holdId: hold.id,
        holdStatus: 'CAPTURED' as const,
        beneficiaryPlayerId: command.beneficiaryPlayerId,
        applied: true,
      }
      await this.persist(tx, command.operationId, intent, result, command.now)
      await this.ledger(
        tx,
        command.operationId,
        hold.id,
        hold.player_id,
        'AUCTION_HOLD_CAPTURED',
        amount,
        balance,
        reserved,
        command.now,
      )
      await this.ledger(
        tx,
        command.operationId,
        hold.id,
        command.beneficiaryPlayerId,
        'AUCTION_SETTLEMENT_CREDIT',
        amount,
        sellerBalance,
        seller.reserved,
        command.now,
      )
      return result
    })
  }
  release(command: ReleaseAuctionHold): Promise<AuctionHoldResult> {
    return this.db.transaction().execute(async (tx) => {
      const intent = ['release', command.holdId, command.reason]
      const replay = await this.replay(tx, command.operationId, intent)
      if (replay) return replay
      const hold = await tx
        .selectFrom('wallet_auction_holds')
        .selectAll()
        .where('id', '=', command.holdId)
        .forUpdate()
        .executeTakeFirst()
      if (!hold) throw new AuctionHoldNotFoundError(command.holdId)
      if (hold.status !== 'ACTIVE') throw new AuctionHoldStateError()
      await lockByText(tx, hold.player_id)
      const account = await this.account(tx, hold.player_id, command.now),
        reserved = account.reserved - Number(hold.amount)
      await tx
        .updateTable('wallet_accounts')
        .set({ reserved, updated_at: command.now })
        .where('player_id', '=', hold.player_id)
        .execute()
      await tx
        .updateTable('wallet_auction_holds')
        .set({ status: 'RELEASED', updated_at: command.now })
        .where('id', '=', hold.id)
        .execute()
      const result = {
        operationId: command.operationId,
        holdId: hold.id,
        holdStatus: 'RELEASED' as const,
        applied: true,
      }
      await this.persist(tx, command.operationId, intent, result, command.now)
      await this.ledger(
        tx,
        command.operationId,
        hold.id,
        hold.player_id,
        'AUCTION_HOLD_RELEASED',
        Number(hold.amount),
        account.balance,
        reserved,
        command.now,
      )
      return result
    })
  }
  async expire(now: Date): Promise<number> {
    const rows = await this.db
      .selectFrom('wallet_auction_holds')
      .select('id')
      .where('status', '=', 'ACTIVE')
      .where('expires_at', '<=', now)
      .execute()
    let count = 0
    for (const row of rows) {
      const applied = await this.db.transaction().execute(async (tx) => {
        const hold = await tx
          .selectFrom('wallet_auction_holds')
          .selectAll()
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirst()
        if (hold?.status !== 'ACTIVE' || hold.expires_at > now) return false
        await lockByText(tx, hold.player_id)
        const account = await this.account(tx, hold.player_id, now),
          reserved = account.reserved - Number(hold.amount),
          operationId = `${hold.id}:expire`
        await tx
          .updateTable('wallet_accounts')
          .set({ reserved, updated_at: now })
          .where('player_id', '=', hold.player_id)
          .execute()
        await tx
          .updateTable('wallet_auction_holds')
          .set({ status: 'EXPIRED', updated_at: now })
          .where('id', '=', hold.id)
          .execute()
        await this.ledger(
          tx,
          operationId,
          hold.id,
          hold.player_id,
          'AUCTION_HOLD_EXPIRED',
          Number(hold.amount),
          account.balance,
          reserved,
          now,
        )
        return true
      })
      if (applied) count++
    }
    return count
  }
  private async replay(
    tx: Tx,
    operationId: string,
    intent: unknown,
  ): Promise<AuctionHoldResult | undefined> {
    await lockByText(tx, operationId)
    const row = await tx
      .selectFrom('wallet_auction_hold_operations')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirst()
    if (!row) return undefined
    if (JSON.stringify(row.intent) !== JSON.stringify(intent))
      throw new OperationConflictError(operationId)
    const result: unknown = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
    return { ...(result as AuctionHoldResult), applied: false }
  }
  private persist(
    tx: Tx,
    operationId: string,
    intent: unknown,
    result: AuctionHoldResult,
    now: Date,
  ): Promise<unknown> {
    return tx
      .insertInto('wallet_auction_hold_operations')
      .values({
        operation_id: operationId,
        intent: JSON.stringify(intent),
        result: JSON.stringify(result),
        created_at: now,
      })
      .execute()
  }
  private ledger(
    tx: Tx,
    operationId: string,
    holdId: string,
    playerId: string,
    kind: string,
    amount: number,
    balance: number,
    reserved: number,
    now: Date,
  ): Promise<unknown> {
    return tx
      .insertInto('wallet_auction_hold_ledger')
      .values({
        operation_id: operationId,
        hold_id: holdId,
        player_id: playerId,
        kind,
        amount,
        resulting_balance: balance,
        resulting_reserved: reserved,
        created_at: now,
      })
      .execute()
  }
  private async account(
    tx: Tx,
    playerId: string,
    now: Date,
  ): Promise<{ balance: number; reserved: number }> {
    await tx
      .insertInto('wallet_accounts')
      .values({
        player_id: playerId,
        balance: 0,
        reserved: 0,
        victory_progress: 0,
        weekly_chest_count: 0,
        week_identity: weekIdentityOf(now),
      })
      .onConflict((c) => c.column('player_id').doNothing())
      .execute()
    const row = await tx
      .selectFrom('wallet_accounts')
      .selectAll()
      .where('player_id', '=', playerId)
      .forUpdate()
      .executeTakeFirstOrThrow()
    return { balance: Number(row.balance), reserved: Number(row.reserved) }
  }
}
