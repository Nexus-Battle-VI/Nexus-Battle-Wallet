import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator'
export class ChargeAuctionPublicationFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  @IsString() @MinLength(1) @MaxLength(200) sellerId!: string
  @IsInt() @IsPositive() amount!: number
}
export class RefundAuctionPublicationFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  /**
   * Monto a reembolsar. Omitido -> refund total (compatibilidad con el
   * unico llamador actual). Si se informa, no es `@IsInt`: HU-90 reembolsa
   * medios creditos (0.5/1.5); el dominio valida la regla exacta y responde
   * 422, no 400 (mismo patron que `wallet-auction-holds.dto.ts`).
   */
  @IsOptional() @IsNumber() amount?: number
}
export class AuctionPublicationFeeResponseDto {
  operationId!: string
  chargeId!: string
  sellerId!: string
  amount!: number
  status!: string
  applied!: boolean
}
