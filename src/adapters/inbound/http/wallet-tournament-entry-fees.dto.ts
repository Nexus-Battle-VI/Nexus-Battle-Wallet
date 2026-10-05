import { IsInt, IsPositive, Max, IsString, MaxLength, MinLength } from 'class-validator'
import type { TournamentEntryFeeStatus } from '../../../application/ports/TournamentEntryFeeRepositoryPort'
export class ChargeTournamentEntryFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
  @IsString() @MinLength(1) @MaxLength(200) payerId!: string
  @IsString() @MinLength(1) @MaxLength(200) tournamentId!: string
  @IsString() @MinLength(1) @MaxLength(200) teamId!: string
  @IsInt() @IsPositive() @Max(Number.MAX_SAFE_INTEGER) amount!: number
}
export class RefundTournamentEntryFeeDto {
  @IsString() @MinLength(1) @MaxLength(200) operationId!: string
}
export class TournamentEntryFeeResponseDto {
  operationId!: string
  chargeId!: string
  payerId!: string
  tournamentId!: string
  teamId!: string
  amount!: number
  status!: TournamentEntryFeeStatus
  applied!: boolean
}
