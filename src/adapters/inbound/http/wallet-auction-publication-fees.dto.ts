import { IsInt, IsPositive, IsString, MaxLength, MinLength } from 'class-validator'
export class ChargeAuctionPublicationFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  @IsString() @MinLength(1) @MaxLength(200) sellerId!: string
  @IsInt() @IsPositive() amount!: number
}
export class RefundAuctionPublicationFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
}
export class AuctionPublicationFeeResponseDto {
  operationId!: string
  chargeId!: string
  sellerId!: string
  amount!: number
  status!: string
  applied!: boolean
}
