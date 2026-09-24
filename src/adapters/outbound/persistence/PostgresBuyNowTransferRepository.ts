import type { Kysely, Transaction } from 'kysely'

import {
  BuyNowTransferInsufficientBalanceError,
  BuyNowTransferNotFoundError,
} from '../../../application/errors/BuyNowTransferError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  BuyNowTransferRepositoryPort,
  BuyNowTransferResult,
  ReverseBuyNowTransfer,
  TransferBuyNowCredits,
} from '../../../application/ports/BuyNowTransferRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import type { Database } from './schema'

type Tx = Transaction<Database>

export class PostgresBuyNowTransferRepository implements BuyNowTransferRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  transfer(command: TransferBuyNowCredits): Promise<BuyNowTransferResult> {
    return this.db.transaction().execute(async (tx) => {
      const intent = ['transfer', command.buyerId, command.sellerId, command.amount]
      const replay = await this.replay(tx, command.operationId, intent)
      if (replay) return replay

      for (const playerId of [command.buyerId, command.sellerId].sort()) {
        await lockByText(tx, playerId)
      }

      const buyer = await this.account(tx, command.buyerId, command.now)
      if (buyer.balance - buyer.reserved < command.amount) {
        throw new BuyNowTransferInsufficientBalanceError()
      }
      const seller = await this.account(tx, command.sellerId, command.now)

      const buyerBalance = buyer.balance - command.amount
      const sellerBalance = seller.balance + command.amount

      await tx
        .updateTable('wallet_accounts')
        .set({ balance: buyerBalance, updated_at: command.now })
        .where('player_id', '=', command.buyerId)
        .execute()
      await tx
        .updateTable('wallet_accounts')
        .set({ balance: sellerBalance, updated_at: command.now })
        .where('player_id', '=', command.sellerId)
        .execute()
      await tx
        .insertInto('wallet_buy_now_transfers')
        .values({
          id: command.operationId,
          buyer_id: command.buyerId,
          seller_id: command.sellerId,
          amount: command.amount,
          status: 'APPLIED',
          created_at: command.now,
          updated_at: command.now,
        })
        .execute()

      const result: BuyNowTransferResult = {
        operationId: command.operationId,
        transferId: command.operationId,
        status: 'APPLIED',
        applied: true,
      }
      await this.persist(tx, command.operationId, intent, result, command.now)
      await this.ledger(
        tx,
        command.operationId,
        command.operationId,
        command.buyerId,
        'BUY_NOW_DEBIT',
        command.amount,
        buyerBalance,
        buyer.reserved,
        command.now,
      )
      await this.ledger(
        tx,
        command.operationId,
        command.operationId,
        command.sellerId,
        'BUY_NOW_CREDIT',
        command.amount,
        sellerBalance,
        seller.reserved,
        command.now,
      )
      return result
    })
  }

  reverse(command: ReverseBuyNowTransfer): Promise<BuyNowTransferResult> {
    return this.db.transaction().execute(async (tx) => {
      await lockByText(tx, command.transferId)

      const transfer = await tx
        .selectFrom('wallet_buy_now_transfers')
        .selectAll()
        .where('id', '=', command.transferId)
        .forUpdate()
        .executeTakeFirst()
      if (!transfer) throw new BuyNowTransferNotFoundError(command.transferId)

      if (transfer.status === 'REVERSED') {
        return {
          operationId: command.operationId,
          transferId: transfer.id,
          status: 'REVERSED' as const,
          applied: false,
        }
      }

      for (const playerId of [transfer.buyer_id, transfer.seller_id].sort()) {
        await lockByText(tx, playerId)
      }

      const amount = Number(transfer.amount)
      const buyer = await this.account(tx, transfer.buyer_id, command.now)
      const seller = await this.account(tx, transfer.seller_id, command.now)
      const buyerBalance = buyer.balance + amount
      const sellerBalance = seller.balance - amount

      await tx
        .updateTable('wallet_accounts')
        .set({ balance: buyerBalance, updated_at: command.now })
        .where('player_id', '=', transfer.buyer_id)
        .execute()
      await tx
        .updateTable('wallet_accounts')
        .set({ balance: sellerBalance, updated_at: command.now })
        .where('player_id', '=', transfer.seller_id)
        .execute()
      await tx
        .updateTable('wallet_buy_now_transfers')
        .set({ status: 'REVERSED', updated_at: command.now })
        .where('id', '=', transfer.id)
        .execute()

      const result: BuyNowTransferResult = {
        operationId: command.operationId,
        transferId: transfer.id,
        status: 'REVERSED',
        applied: true,
      }
      await this.ledger(
        tx,
        command.operationId,
        transfer.id,
        transfer.buyer_id,
        'BUY_NOW_REVERSAL_CREDIT',
        amount,
        buyerBalance,
        buyer.reserved,
        command.now,
      )
      await this.ledger(
        tx,
        command.operationId,
        transfer.id,
        transfer.seller_id,
        'BUY_NOW_REVERSAL_DEBIT',
        amount,
        sellerBalance,
        seller.reserved,
        command.now,
      )
      return result
    })
  }

  private async replay(
    tx: Tx,
    operationId: string,
    intent: unknown,
  ): Promise<BuyNowTransferResult | undefined> {
    await lockByText(tx, operationId)
    const row = await tx
      .selectFrom('wallet_buy_now_transfer_operations')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirst()
    if (!row) return undefined
    if (JSON.stringify(row.intent) !== JSON.stringify(intent)) {
      throw new OperationConflictError(operationId)
    }
    const result: unknown = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
    return { ...(result as BuyNowTransferResult), applied: false }
  }

  private persist(
    tx: Tx,
    operationId: string,
    intent: unknown,
    result: BuyNowTransferResult,
    now: Date,
  ): Promise<unknown> {
    return tx
      .insertInto('wallet_buy_now_transfer_operations')
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
    transferId: string,
    playerId: string,
    kind: string,
    amount: number,
    balance: number,
    reserved: number,
    now: Date,
  ): Promise<unknown> {
    return tx
      .insertInto('wallet_buy_now_transfer_ledger')
      .values({
        operation_id: operationId,
        transfer_id: transferId,
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
