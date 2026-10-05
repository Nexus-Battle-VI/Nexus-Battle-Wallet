import { ApiProperty } from '@nestjs/swagger'
import {
  AUCTION_HOLD_RELEASE_REASONS,
  type AuctionHoldReleaseReason,
} from '../../../application/ports/AuctionHoldRepositoryPort'
import { IsDateString, IsIn, IsNumber, IsString, MaxLength, MinLength } from 'class-validator'
export class CreateAuctionHoldDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  @ApiProperty() @IsString() playerId!: string
  @ApiProperty() @IsNumber() amount!: number
  @ApiProperty() @IsString() auctionId!: string
  @ApiProperty() @IsString() bidId!: string
  @ApiProperty() @IsDateString() auctionClosesAt!: string
}
export class CaptureAuctionHoldDto {
  @ApiProperty() @IsString() operationId!: string
  @ApiProperty() @IsString() beneficiaryPlayerId!: string
  @ApiProperty() @IsString() auctionId!: string
  @ApiProperty() @IsString() winningBidId!: string
}
export class ReleaseAuctionHoldDto {
  @ApiProperty() @IsString() operationId!: string
  @ApiProperty({
    enum: AUCTION_HOLD_RELEASE_REASONS,
    description:
      'Motivo del release. AUCTION_CANCELLED: la subasta se cancelo y se libera a todos los postores. Forma parte de la huella de idempotencia.',
  })
  @IsIn(AUCTION_HOLD_RELEASE_REASONS)
  reason!: AuctionHoldReleaseReason
}
export class AuctionHoldResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() holdId!: string
  @ApiProperty({ enum: ['ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'] }) holdStatus!: string
  @ApiProperty({
    description:
      'false si la llamada no movio saldo: un replay, o un release de un hold ya RELEASED o EXPIRED.',
  })
  applied!: boolean
  @ApiProperty({ required: false }) beneficiaryPlayerId?: string
}
