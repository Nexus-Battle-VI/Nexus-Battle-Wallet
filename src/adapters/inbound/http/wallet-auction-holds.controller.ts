import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { AUCTION_HOLDS, AuctionHolds } from '../../../application/use-cases/AuctionHolds'
import { InternalOnly } from './auth/decorators'
import {
  AuctionHoldResponseDto,
  CaptureAuctionHoldDto,
  CreateAuctionHoldDto,
  ReleaseAuctionHoldDto,
} from './wallet-auction-holds.dto'
import { toWalletHttpException } from './wallet-error.mapper'
@InternalOnly('auction')
@Controller('internal/v1/wallet/holds')
export class WalletAuctionHoldsController {
  constructor(@Inject(AUCTION_HOLDS) private readonly holds: AuctionHolds) {}
  @Post() @HttpCode(HttpStatus.OK) async create(
    @Body() body: CreateAuctionHoldDto,
  ): Promise<AuctionHoldResponseDto> {
    try {
      return await this.holds.create({
        operationId: body.operationId,
        playerId: body.playerId,
        amount: body.amount,
        auctionId: body.auctionId,
        bidId: body.bidId,
        auctionClosesAt: new Date(body.auctionClosesAt),
      })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
  @Post(':holdId/captures') @HttpCode(HttpStatus.OK) async capture(
    @Param('holdId') holdId: string,
    @Body() body: CaptureAuctionHoldDto,
  ): Promise<AuctionHoldResponseDto> {
    try {
      return await this.holds.capture({
        operationId: body.operationId,
        holdId,
        beneficiaryPlayerId: body.beneficiaryPlayerId,
        auctionId: body.auctionId,
        winningBidId: body.winningBidId,
      })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
  @Post(':holdId/releases') @HttpCode(HttpStatus.OK) async release(
    @Param('holdId') holdId: string,
    @Body() body: ReleaseAuctionHoldDto,
  ): Promise<AuctionHoldResponseDto> {
    try {
      return await this.holds.release({
        operationId: body.operationId,
        holdId,
        reason: body.reason,
      })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
