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
import { InMemoryWalletStore, type InMemoryAccountState } from './InMemoryWalletStore'

export class InMemoryAuctionPublicationFeeRepository implements AuctionPublicationFeeRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async charge(command: ChargeAuctionPublicationFee): Promise<AuctionPublicationFeeResult> {
    const intent = JSON.stringify(['charge', command.sellerId, command.amount])
    const replay = this.store.publicationFeeOperations.get(command.operationId)
    if (replay) {
      if (replay.intent !== intent) throw new OperationConflictError(command.operationId)
      return { ...replay.result, applied: false }
    }
    const account = this.account(command.sellerId, command.now)
    if (account.balance - account.reserved < command.amount)
      throw new AuctionPublicationFeeInsufficientBalanceError()
    account.balance -= command.amount
    const result: AuctionPublicationFeeResult = {
      operationId: command.operationId,
      chargeId: command.operationId,
      sellerId: command.sellerId,
      amount: command.amount,
      status: 'CHARGED',
      applied: true,
    }
    this.store.publicationFees.set(result.chargeId, { ...result })
    this.store.publicationFeeOperations.set(command.operationId, { intent, result })
    return result
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(command: RefundAuctionPublicationFee): Promise<AuctionPublicationFeeResult> {
    const previousChargeId = this.store.publicationFeeRefunds.get(command.operationId)
    if (previousChargeId !== undefined) {
      if (previousChargeId !== command.chargeId)
        throw new OperationConflictError(command.operationId)
      const replay = this.store.publicationFees.get(command.chargeId)
      if (!replay) throw new AuctionPublicationFeeNotFoundError(command.chargeId)
      return { operationId: command.operationId, ...replay, applied: false }
    }
    const fee = this.store.publicationFees.get(command.chargeId)
    if (!fee) throw new AuctionPublicationFeeNotFoundError(command.chargeId)
    this.store.publicationFeeRefunds.set(command.operationId, command.chargeId)
    if (fee.status === 'REFUNDED')
      return {
        operationId: command.operationId,
        chargeId: fee.chargeId,
        sellerId: fee.sellerId,
        amount: fee.amount,
        status: 'REFUNDED',
        applied: false,
      }
    this.account(fee.sellerId, command.now).balance += fee.amount
    fee.status = 'REFUNDED'
    const result: AuctionPublicationFeeResult = {
      operationId: command.operationId,
      chargeId: fee.chargeId,
      sellerId: fee.sellerId,
      amount: fee.amount,
      status: 'REFUNDED',
      applied: true,
    }
    return result
  }
  private account(playerId: string, now: Date): InMemoryAccountState {
    const found = this.store.accounts.get(playerId)
    if (found) return found
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
