import type { ClockPort } from '../ports/ClockPort'
import type {
  BuyNowTransferRepositoryPort,
  BuyNowTransferResult,
} from '../ports/BuyNowTransferRepositoryPort'
import {
  BuyNowTransferSameAccountError,
  InvalidBuyNowTransferAmountError,
} from '../errors/BuyNowTransferError'

/**
 * Caso de uso de HU-64.8: transferencia directa de creditos comprador ->
 * vendedor para la compra inmediata (HU-64), y su reversa cuando un paso
 * posterior en Auction falla.
 *
 * A diferencia de `AuctionHolds` (HU-65.2), aqui no hay estado intermedio de
 * reserva: la compra inmediata no tiene puja previa ni espera, asi que
 * `transfer` debita y acredita en la misma operacion.
 */
export class BuyNowTransfers {
  constructor(
    private readonly repository: BuyNowTransferRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async transfer(input: {
    operationId: string
    buyerId: string
    sellerId: string
    amount: number
  }): Promise<BuyNowTransferResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new InvalidBuyNowTransferAmountError()
    }
    if (input.buyerId === input.sellerId) {
      throw new BuyNowTransferSameAccountError()
    }
    return this.repository.transfer({ ...input, now: this.clock.now() })
  }

  reverse(input: { operationId: string; transferId: string }): Promise<BuyNowTransferResult> {
    return this.repository.reverse({ ...input, now: this.clock.now() })
  }
}

export const BUY_NOW_TRANSFERS = Symbol('BuyNowTransfers')
