import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsPositive, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateBuyNowTransferDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  @ApiProperty() @IsString() buyerId!: string
  @ApiProperty() @IsString() sellerId!: string
  @ApiProperty() @IsInt() @IsPositive() amount!: number
}

export class ReverseBuyNowTransferDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) operationId!: string
}

export class BuyNowTransferResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() transferId!: string
  @ApiProperty() status!: string
  @ApiProperty() applied!: boolean
}

export class BuyNowAvailableBalanceResponseDto {
  @ApiProperty() playerId!: string
  @ApiProperty() balance!: number
  @ApiProperty() reserved!: number
  @ApiProperty() available!: number
}
