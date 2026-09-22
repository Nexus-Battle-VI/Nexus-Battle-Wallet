export type AuctionHoldStatus = 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED'
export interface AuctionHoldResult {
  readonly operationId: string
  readonly holdId: string
  readonly holdStatus: AuctionHoldStatus
  readonly applied: boolean
  readonly beneficiaryPlayerId?: string
}
export interface CreateAuctionHold {
  readonly operationId: string
  readonly playerId: string
  readonly amount: number
  readonly auctionId: string
  readonly bidId: string
  readonly closesAt: Date
  readonly now: Date
  readonly graceMs: number
}
export interface CaptureAuctionHold {
  readonly operationId: string
  readonly holdId: string
  readonly beneficiaryPlayerId: string
  readonly auctionId: string
  readonly winningBidId: string
  readonly now: Date
}
export interface ReleaseAuctionHold {
  readonly operationId: string
  readonly holdId: string
  readonly reason: 'AUCTION_OUTBID' | 'AUCTION_SETTLEMENT_LOST'
  readonly now: Date
}
export interface AuctionHoldRepositoryPort {
  create(command: CreateAuctionHold): Promise<AuctionHoldResult>
  capture(command: CaptureAuctionHold): Promise<AuctionHoldResult>
  release(command: ReleaseAuctionHold): Promise<AuctionHoldResult>
  expire(now: Date): Promise<number>
}
export const AUCTION_HOLD_REPOSITORY = Symbol('AuctionHoldRepositoryPort')
