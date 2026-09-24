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
import { InMemoryWalletStore, type InMemoryAccountState } from './InMemoryWalletStore'

export class InMemoryBuyNowTransferRepository implements BuyNowTransferRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async transfer(command: TransferBuyNowCredits): Promise<BuyNowTransferResult> {
    const intent = JSON.stringify(['transfer', command.buyerId, command.sellerId, command.amount])
    const replay = this.replay(command.operationId, intent)
    if (replay) return replay

    const buyer = this.account(command.buyerId, command.now)
    if (buyer.balance - buyer.reserved < command.amount) {
      throw new BuyNowTransferInsufficientBalanceError()
    }
    const seller = this.account(command.sellerId, command.now)

    buyer.balance -= command.amount
    seller.balance += command.amount

    this.store.buyNowTransfers.set(command.operationId, {
      id: command.operationId,
      buyerId: command.buyerId,
      sellerId: command.sellerId,
      amount: command.amount,
      status: 'APPLIED',
    })

    const result: BuyNowTransferResult = {
      operationId: command.operationId,
      transferId: command.operationId,
      status: 'APPLIED',
      applied: true,
    }
    this.store.buyNowTransferOperations.set(command.operationId, { intent, result })

    return result
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async reverse(command: ReverseBuyNowTransfer): Promise<BuyNowTransferResult> {
    const transfer = this.store.buyNowTransfers.get(command.transferId)
    if (!transfer) throw new BuyNowTransferNotFoundError(command.transferId)

    if (transfer.status === 'REVERSED') {
      return {
        operationId: command.operationId,
        transferId: transfer.id,
        status: 'REVERSED',
        applied: false,
      }
    }

    const buyer = this.account(transfer.buyerId, command.now)
    const seller = this.account(transfer.sellerId, command.now)

    buyer.balance += transfer.amount
    seller.balance -= transfer.amount
    transfer.status = 'REVERSED'

    return {
      operationId: command.operationId,
      transferId: transfer.id,
      status: 'REVERSED',
      applied: true,
    }
  }

  private replay(operationId: string, intent: string): BuyNowTransferResult | undefined {
    const existing = this.store.buyNowTransferOperations.get(operationId)
    if (!existing) return undefined
    if (existing.intent !== intent) throw new OperationConflictError(operationId)
    return { ...existing.result, applied: false }
  }

  private account(playerId: string, now: Date): InMemoryAccountState {
    const existing = this.store.accounts.get(playerId)
    if (existing) return existing
    const created = {
      balance: 0,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: weekIdentityOf(now),
    }
    this.store.accounts.set(playerId, created)
    return created
  }
}
