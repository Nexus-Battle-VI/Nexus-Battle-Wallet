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
import { InMemoryWalletStore, type InMemoryAccountState } from './InMemoryWalletStore'

export class InMemoryAuctionHoldRepository implements AuctionHoldRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async create(command: CreateAuctionHold): Promise<AuctionHoldResult> {
    const intent = JSON.stringify([
      'create',
      command.playerId,
      command.amount,
      command.auctionId,
      command.bidId,
      command.closesAt.toISOString(),
    ])
    const replay = this.replay(command.operationId, intent)
    if (replay) return replay
    const account = this.account(command.playerId, command.now)
    if (account.balance - account.reserved < command.amount)
      throw new AuctionHoldInsufficientBalanceError()
    account.reserved += command.amount
    const result = {
      operationId: command.operationId,
      holdId: command.operationId,
      holdStatus: 'ACTIVE' as const,
      applied: true,
    }
    this.store.auctionHolds.set(command.operationId, {
      id: command.operationId,
      playerId: command.playerId,
      amount: command.amount,
      auctionId: command.auctionId,
      bidId: command.bidId,
      status: 'ACTIVE',
      expiresAt: new Date(command.closesAt.getTime() + command.graceMs),
    })
    this.store.auctionOperations.set(command.operationId, { intent, result })
    return result
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async capture(command: CaptureAuctionHold): Promise<AuctionHoldResult> {
    const intent = JSON.stringify([
      'capture',
      command.holdId,
      command.beneficiaryPlayerId,
      command.auctionId,
      command.winningBidId,
    ])
    const replay = this.replay(command.operationId, intent)
    if (replay) return replay
    const hold = this.store.auctionHolds.get(command.holdId)
    if (!hold) throw new AuctionHoldNotFoundError(command.holdId)
    if (hold.status !== 'ACTIVE') throw new AuctionHoldStateError()
    if (hold.auctionId !== command.auctionId || hold.bidId !== command.winningBidId)
      throw new AuctionHoldReferenceError()
    const winner = this.account(hold.playerId, command.now)
    const seller = this.account(command.beneficiaryPlayerId, command.now)
    winner.reserved -= hold.amount
    winner.balance -= hold.amount
    seller.balance += hold.amount
    hold.status = 'CAPTURED'
    const result = {
      operationId: command.operationId,
      holdId: hold.id,
      holdStatus: 'CAPTURED' as const,
      beneficiaryPlayerId: command.beneficiaryPlayerId,
      applied: true,
    }
    this.store.auctionOperations.set(command.operationId, { intent, result })
    return result
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async release(command: ReleaseAuctionHold): Promise<AuctionHoldResult> {
    const intent = JSON.stringify(['release', command.holdId, command.reason])
    const replay = this.replay(command.operationId, intent)
    if (replay) return replay
    const hold = this.store.auctionHolds.get(command.holdId)
    if (!hold) throw new AuctionHoldNotFoundError(command.holdId)
    if (hold.status !== 'ACTIVE') throw new AuctionHoldStateError()
    const account = this.account(hold.playerId, command.now)
    account.reserved -= hold.amount
    hold.status = 'RELEASED'
    const result = {
      operationId: command.operationId,
      holdId: hold.id,
      holdStatus: 'RELEASED' as const,
      applied: true,
    }
    this.store.auctionOperations.set(command.operationId, { intent, result })
    return result
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async expire(now: Date): Promise<number> {
    let count = 0
    for (const hold of this.store.auctionHolds.values())
      if (hold.status === 'ACTIVE' && hold.expiresAt <= now) {
        this.account(hold.playerId, now).reserved -= hold.amount
        hold.status = 'EXPIRED'
        count += 1
      }
    return count
  }
  private replay(operationId: string, intent: string): AuctionHoldResult | undefined {
    const existing = this.store.auctionOperations.get(operationId)
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
