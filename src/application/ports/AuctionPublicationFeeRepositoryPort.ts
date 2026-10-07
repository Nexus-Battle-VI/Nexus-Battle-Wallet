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
  /**
   * Monto a reembolsar. Si se omite, se reembolsa el monto completo cobrado
   * (comportamiento previo a HU-90, preservado para no romper al llamador
   * actual, que nunca lo envia). Si se informa, debe ser positivo, multiplo
   * de 0.5 y no superar lo cobrado originalmente.
   */
  readonly amount?: number
  readonly now: Date
}

export interface AuctionPublicationFeeRepositoryPort {
  charge(command: ChargeAuctionPublicationFee): Promise<AuctionPublicationFeeResult>
  refund(command: RefundAuctionPublicationFee): Promise<AuctionPublicationFeeResult>
}

export const AUCTION_PUBLICATION_FEE_REPOSITORY = Symbol('AuctionPublicationFeeRepositoryPort')
