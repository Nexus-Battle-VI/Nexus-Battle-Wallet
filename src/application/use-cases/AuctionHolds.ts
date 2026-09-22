import type { ClockPort } from '../ports/ClockPort'
import type {
  AuctionHoldRepositoryPort,
  AuctionHoldResult,
} from '../ports/AuctionHoldRepositoryPort'
import {
  AuctionHoldDateTooFarError,
  ExpiredAuctionHoldDateError,
  InvalidAuctionHoldDateError,
} from '../errors/AuctionHoldError'
export class AuctionHolds {
  constructor(
    private readonly repository: AuctionHoldRepositoryPort,
    private readonly clock: ClockPort,
    private readonly graceMs: number,
    private readonly maxCloseAheadMs: number,
  ) {}
  async create(input: {
    operationId: string
    playerId: string
    amount: number
    auctionId: string
    bidId: string
    auctionClosesAt: Date
  }): Promise<AuctionHoldResult> {
    const now = this.clock.now()
    if (
      !Number.isInteger(input.amount) ||
      input.amount <= 0 ||
      Number.isNaN(input.auctionClosesAt.getTime())
    )
      throw new InvalidAuctionHoldDateError()
    if (input.auctionClosesAt.getTime() <= now.getTime()) throw new ExpiredAuctionHoldDateError()
    if (input.auctionClosesAt.getTime() - now.getTime() > this.maxCloseAheadMs)
      throw new AuctionHoldDateTooFarError()
    return this.repository.create({
      ...input,
      closesAt: input.auctionClosesAt,
      now,
      graceMs: this.graceMs,
    })
  }
  capture(input: {
    operationId: string
    holdId: string
    beneficiaryPlayerId: string
    auctionId: string
    winningBidId: string
  }) {
    return this.repository.capture({ ...input, now: this.clock.now() })
  }
  release(input: {
    operationId: string
    holdId: string
    reason: 'AUCTION_OUTBID' | 'AUCTION_SETTLEMENT_LOST'
  }) {
    return this.repository.release({ ...input, now: this.clock.now() })
  }
}
export const AUCTION_HOLDS = Symbol('AuctionHolds')
