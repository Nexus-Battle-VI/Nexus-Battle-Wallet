import { InvalidAuctionPublicationFeeAmountError } from '../errors/AuctionPublicationFeeError'
import type { ClockPort } from '../ports/ClockPort'
import type {
  AuctionPublicationFeeRepositoryPort,
  AuctionPublicationFeeResult,
} from '../ports/AuctionPublicationFeeRepositoryPort'

export class AuctionPublicationFees {
  constructor(
    private readonly repository: AuctionPublicationFeeRepositoryPort,
    private readonly clock: ClockPort,
  ) {}
  charge(input: {
    operationId: string
    sellerId: string
    amount: number
  }): Promise<AuctionPublicationFeeResult> {
    if (
      !input.operationId.trim() ||
      !input.sellerId.trim() ||
      !Number.isInteger(input.amount) ||
      input.amount <= 0
    )
      throw new InvalidAuctionPublicationFeeAmountError()
    return this.repository.charge({ ...input, now: this.clock.now() })
  }
  refund(input: { operationId: string; chargeId: string }): Promise<AuctionPublicationFeeResult> {
    if (!input.operationId.trim() || !input.chargeId.trim())
      throw new InvalidAuctionPublicationFeeAmountError()
    return this.repository.refund({ ...input, now: this.clock.now() })
  }
}
export const AUCTION_PUBLICATION_FEES = Symbol('AuctionPublicationFees')
