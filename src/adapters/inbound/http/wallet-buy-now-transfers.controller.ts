import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'

import {
  GET_WALLET_SNAPSHOT,
  GetWalletSnapshot,
} from '../../../application/use-cases/GetWalletSnapshot'
import { BUY_NOW_TRANSFERS, BuyNowTransfers } from '../../../application/use-cases/BuyNowTransfers'
import { InternalOnly } from './auth/decorators'
import {
  BuyNowAvailableBalanceResponseDto,
  BuyNowTransferResponseDto,
  CreateBuyNowTransferDto,
  ReverseBuyNowTransferDto,
} from './wallet-buy-now-transfers.dto'
import { toWalletHttpException } from './wallet-error.mapper'

/** HU-64.8: transferencia directa de creditos para la compra inmediata de Auction (HU-64). */
@InternalOnly('auction')
@Controller('internal/v1/wallet/buy-now-transfers')
export class WalletBuyNowTransfersController {
  constructor(
    @Inject(BUY_NOW_TRANSFERS) private readonly transfers: BuyNowTransfers,
    @Inject(GET_WALLET_SNAPSHOT) private readonly walletSnapshot: GetWalletSnapshot,
  ) {}

  /**
   * Saldo disponible de un jugador por su identificador (no el "me" del
   * testimonio): Auction necesita el saldo del COMPRADOR para CA-02 de
   * HU-64.4, evaluado server-side antes de aprobar la compra, no el de quien
   * hace la llamada interna. Reutiliza `GetWalletSnapshot`, el mismo caso de
   * uso de `GET /v1/wallet/me`, sin duplicar el calculo de `available`.
   */
  @Get('balance/:playerId')
  @HttpCode(HttpStatus.OK)
  async balance(@Param('playerId') playerId: string): Promise<BuyNowAvailableBalanceResponseDto> {
    const snapshot = await this.walletSnapshot.execute(playerId)

    return {
      playerId,
      balance: snapshot.balance,
      reserved: snapshot.reserved,
      available: snapshot.available,
    }
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: CreateBuyNowTransferDto): Promise<BuyNowTransferResponseDto> {
    try {
      return await this.transfers.transfer({
        operationId: body.operationId,
        buyerId: body.buyerId,
        sellerId: body.sellerId,
        amount: body.amount,
      })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }

  @Post(':transferId/reversals')
  @HttpCode(HttpStatus.OK)
  async reverse(
    @Param('transferId') transferId: string,
    @Body() body: ReverseBuyNowTransferDto,
  ): Promise<BuyNowTransferResponseDto> {
    try {
      return await this.transfers.reverse({
        operationId: body.operationId,
        transferId,
      })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
