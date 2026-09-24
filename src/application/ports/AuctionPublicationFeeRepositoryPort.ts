export type AuctionPublicationFeeStatus = 'CHARGED' | 'REFUNDED'

export interface AuctionPublicationFeeResult {
  readonly operationId: string
  readonly chargeId: string
  readonly sellerId: string
  readonly amount: number
  readonly status: AuctionPublicationFeeStatus
  readonly applied: boolean
}

export interface ChargeAuctionPublicationFee {
  readonly operationId: string
  readonly sellerId: string
  readonly amount: number
  readonly now: Date
}

export interface RefundAuctionPublicationFee {
  readonly operationId: string
  readonly chargeId: string
  readonly now: Date
}

export interface AuctionPublicationFeeRepositoryPort {
  charge(command: ChargeAuctionPublicationFee): Promise<AuctionPublicationFeeResult>
  refund(command: RefundAuctionPublicationFee): Promise<AuctionPublicationFeeResult>
}

export const AUCTION_PUBLICATION_FEE_REPOSITORY = Symbol('AuctionPublicationFeeRepositoryPort')
