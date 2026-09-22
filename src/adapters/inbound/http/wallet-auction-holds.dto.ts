import { ApiProperty } from '@nestjs/swagger'
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
  @ApiProperty({ enum: ['AUCTION_OUTBID', 'AUCTION_SETTLEMENT_LOST'] })
  @IsIn(['AUCTION_OUTBID', 'AUCTION_SETTLEMENT_LOST'])
  reason!: 'AUCTION_OUTBID' | 'AUCTION_SETTLEMENT_LOST'
}
export class AuctionHoldResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() holdId!: string
  @ApiProperty() holdStatus!: string
  @ApiProperty() applied!: boolean
  @ApiProperty({ required: false }) beneficiaryPlayerId?: string
}
