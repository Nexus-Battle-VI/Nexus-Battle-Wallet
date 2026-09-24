import type { Kysely, Transaction } from 'kysely'
import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
} from '../../../application/errors/AuctionPublicationFeeError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  AuctionPublicationFeeRepositoryPort,
  AuctionPublicationFeeResult,
  ChargeAuctionPublicationFee,
  RefundAuctionPublicationFee,
} from '../../../application/ports/AuctionPublicationFeeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import type { Database } from './schema'
type Tx = Transaction<Database>
export class PostgresAuctionPublicationFeeRepository implements AuctionPublicationFeeRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  charge(c: ChargeAuctionPublicationFee): Promise<AuctionPublicationFeeResult> {
    return this.db.transaction().execute(async (tx) => {
      await lockByText(tx, c.operationId)
      const existing = await tx
        .selectFrom('wallet_auction_publication_fees')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .executeTakeFirst()
      if (existing) {
        if (existing.seller_id !== c.sellerId || Number(existing.amount) !== c.amount)
          throw new OperationConflictError(c.operationId)
        return this.result(c.operationId, existing, false)
      }
      await lockByText(tx, c.sellerId)
      const a = await this.account(tx, c.sellerId, c.now)
      if (a.balance - a.reserved < c.amount)
        throw new AuctionPublicationFeeInsufficientBalanceError()
      await tx
        .updateTable('wallet_accounts')
        .set({ balance: a.balance - c.amount, updated_at: c.now })
        .where('player_id', '=', c.sellerId)
        .execute()
      await tx
        .insertInto('wallet_auction_publication_fees')
        .values({
          charge_id: c.operationId,
          operation_id: c.operationId,
          seller_id: c.sellerId,
          amount: c.amount,
          status: 'CHARGED',
          created_at: c.now,
          refunded_at: null,
        })
        .execute()
      return {
        operationId: c.operationId,
        chargeId: c.operationId,
        sellerId: c.sellerId,
        amount: c.amount,
        status: 'CHARGED',
        applied: true,
      }
    })
  }
  refund(c: RefundAuctionPublicationFee): Promise<AuctionPublicationFeeResult> {
    return this.db.transaction().execute(async (tx) => {
      await lockByText(tx, c.operationId)
      const reused = await tx
        .selectFrom('wallet_auction_publication_fee_refunds')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .executeTakeFirst()
      if (reused && reused.charge_id !== c.chargeId) throw new OperationConflictError(c.operationId)
      const fee = await tx
        .selectFrom('wallet_auction_publication_fees')
        .selectAll()
        .where('charge_id', '=', c.chargeId)
        .forUpdate()
        .executeTakeFirst()
      if (!fee) throw new AuctionPublicationFeeNotFoundError(c.chargeId)
      if (reused) return this.result(c.operationId, fee, false)
      await tx
        .insertInto('wallet_auction_publication_fee_refunds')
        .values({ operation_id: c.operationId, charge_id: c.chargeId, created_at: c.now })
        .execute()
      if (fee.status === 'REFUNDED') return this.result(c.operationId, fee, false)
      await lockByText(tx, fee.seller_id)
      const a = await this.account(tx, fee.seller_id, c.now)
      await tx
        .updateTable('wallet_accounts')
        .set({ balance: a.balance + Number(fee.amount), updated_at: c.now })
        .where('player_id', '=', fee.seller_id)
        .execute()
      await tx
        .updateTable('wallet_auction_publication_fees')
        .set({ status: 'REFUNDED', refunded_at: c.now })
        .where('charge_id', '=', fee.charge_id)
        .execute()
      return {
        operationId: c.operationId,
        chargeId: fee.charge_id,
        sellerId: fee.seller_id,
        amount: Number(fee.amount),
        status: 'REFUNDED',
        applied: true,
      }
    })
  }
  private result(
    operationId: string,
    row: {
      charge_id: string
      seller_id: string
      amount: string | number
      status: 'CHARGED' | 'REFUNDED'
    },
    applied: boolean,
  ): AuctionPublicationFeeResult {
    return {
      operationId,
      chargeId: row.charge_id,
      sellerId: row.seller_id,
      amount: Number(row.amount),
      status: row.status,
      applied,
    }
  }
  private async account(
    tx: Tx,
    id: string,
    now: Date,
  ): Promise<{ balance: number; reserved: number }> {
    await tx
      .insertInto('wallet_accounts')
      .values({
        player_id: id,
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
      .where('player_id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    return { balance: Number(row.balance), reserved: Number(row.reserved) }
  }
}
