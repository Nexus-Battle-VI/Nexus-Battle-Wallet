import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import {
  AUCTION_PUBLICATION_FEES,
  AuctionPublicationFees,
} from '../../../application/use-cases/AuctionPublicationFees'
import { InternalOnly } from './auth/decorators'
import { toWalletHttpException } from './wallet-error.mapper'
import {
  AuctionPublicationFeeResponseDto,
  ChargeAuctionPublicationFeeDto,
  RefundAuctionPublicationFeeDto,
} from './wallet-auction-publication-fees.dto'
@InternalOnly('auction')
@Controller('internal/v1/wallet/auction-publication-fees')
export class WalletAuctionPublicationFeesController {
  constructor(@Inject(AUCTION_PUBLICATION_FEES) private readonly fees: AuctionPublicationFees) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  async charge(
    @Body() body: ChargeAuctionPublicationFeeDto,
  ): Promise<AuctionPublicationFeeResponseDto> {
    try {
      return await this.fees.charge(body)
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
  @Post(':chargeId/refunds')
  @HttpCode(HttpStatus.OK)
  async refund(
    @Param('chargeId') chargeId: string,
    @Body() body: RefundAuctionPublicationFeeDto,
  ): Promise<AuctionPublicationFeeResponseDto> {
    try {
      return await this.fees.refund({ operationId: body.operationId, chargeId })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
