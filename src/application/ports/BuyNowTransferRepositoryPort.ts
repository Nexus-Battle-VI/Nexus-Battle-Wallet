export type BuyNowTransferStatus = 'APPLIED' | 'REVERSED'

export interface BuyNowTransferResult {
  readonly operationId: string
  readonly transferId: string
  readonly status: BuyNowTransferStatus
  /** `false` cuando la llamada fue un reintento (replay) o la reversa ya se habia aplicado antes. */
  readonly applied: boolean
}

export interface TransferBuyNowCredits {
  readonly operationId: string
  readonly buyerId: string
  readonly sellerId: string
  readonly amount: number
  readonly now: Date
}

export interface ReverseBuyNowTransfer {
  readonly operationId: string
  readonly transferId: string
  readonly now: Date
}

export interface BuyNowTransferRepositoryPort {
  transfer(command: TransferBuyNowCredits): Promise<BuyNowTransferResult>
  reverse(command: ReverseBuyNowTransfer): Promise<BuyNowTransferResult>
}

export const BUY_NOW_TRANSFER_REPOSITORY = Symbol('BuyNowTransferRepositoryPort')
