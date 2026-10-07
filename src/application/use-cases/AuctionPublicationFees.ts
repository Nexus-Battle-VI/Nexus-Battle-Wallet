import {
  InvalidAuctionPublicationFeeAmountError,
  InvalidAuctionPublicationFeeRefundAmountError,
} from '../errors/AuctionPublicationFeeError'
import type { ClockPort } from '../ports/ClockPort'
import type {
  AuctionPublicationFeeRepositoryPort,
  AuctionPublicationFeeResult,
} from '../ports/AuctionPublicationFeeRepositoryPort'

/**
 * La unica fraccion que HU-90 necesita: la mitad de una comision de 1 o 3
 * creditos (0.5 o 1.5). `amount * 2` es exacto en IEEE-754 para estos
 * valores, asi que la comparacion no sufre el problema habitual de punto
 * flotante.
 */
const isHalfCreditMultiple = (amount: number): boolean =>
  Number.isFinite(amount) && amount > 0 && Math.round(amount * 2) === amount * 2

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
  refund(input: {
    operationId: string
    chargeId: string
    amount?: number
  }): Promise<AuctionPublicationFeeResult> {
    if (!input.operationId.trim() || !input.chargeId.trim())
      throw new InvalidAuctionPublicationFeeAmountError()
    if (input.amount !== undefined && !isHalfCreditMultiple(input.amount))
      throw new InvalidAuctionPublicationFeeRefundAmountError()
    return this.repository.refund({ ...input, now: this.clock.now() })
  }
}
export const AUCTION_PUBLICATION_FEES = Symbol('AuctionPublicationFees')
