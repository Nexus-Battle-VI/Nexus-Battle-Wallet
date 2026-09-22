import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator'

import type {
  StakeReleaseReason,
  StakeSettlementOutcome,
} from '../../../application/ports/StakeRepositoryPort'

/**
 * Combat -> Wallet, apuestas (`hu-23-battle-stake-v1.md` §5).
 *
 * `amount` se declara como numero, sin `@Min(1)` ni `@IsInt`: el contrato fija
 * que un monto <= 0 o no entero responde 422 `INVALID_AMOUNT` (lo valida el
 * dominio), no 400. Aqui solo se rechaza lo que no es un numero en absoluto.
 */
export class ReserveStakeRequestDto {
  @ApiProperty({ example: 'battle:room-1:player:sub-1:stake:reserve' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  operationId!: string

  @ApiProperty({ example: 'cognito-sub-del-jugador' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  playerId!: string

  @ApiProperty({ example: 'room-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  battleId!: string

  @ApiProperty({ example: 10, minimum: 1 })
  @IsNumber()
  amount!: number

  @ApiProperty({ example: '2026-09-22T10:00:00.000Z' })
  @IsDateString()
  occurredAt!: string
}

export class ReserveStakeResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() applied!: boolean
  @ApiProperty() holdId!: string
  @ApiProperty() balance!: number
  @ApiProperty() reserved!: number
  @ApiProperty() available!: number
}

export class ReleaseStakeRequestDto {
  @ApiProperty({ example: 'battle:room-1:player:sub-1:stake:release' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  operationId!: string

  @ApiProperty({ example: 'battle:room-1:player:sub-1:stake:reserve' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  holdId!: string

  @ApiProperty({ enum: ['ROOM_CANCELLED', 'PARTICIPANT_LEFT', 'NO_WINNER'] })
  @IsIn(['ROOM_CANCELLED', 'PARTICIPANT_LEFT', 'NO_WINNER'])
  reason!: StakeReleaseReason
}

export class ReleaseStakeResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() applied!: boolean
  @ApiProperty() holdId!: string
  @ApiProperty() balance!: number
  @ApiProperty() reserved!: number
  @ApiProperty() available!: number
}

export class SettleStakeEntryDto {
  @ApiProperty({ example: 'cognito-sub-del-jugador' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  playerId!: string

  @ApiProperty({ example: 'battle:room-1:player:sub-1:stake:reserve' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  holdId!: string

  @ApiProperty({ enum: ['CAPTURED', 'CREDITED'] })
  @IsIn(['CAPTURED', 'CREDITED'])
  outcome!: StakeSettlementOutcome

  @ApiProperty({ example: 10 })
  @IsNumber()
  amount!: number
}

export class SettleStakesRequestDto {
  @ApiProperty({ example: 'battle:room-1:stakes:settle' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  operationId!: string

  @ApiProperty({ example: 'room-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  battleId!: string

  // Sin `@ArrayMinSize`: una lista vacia es un error de FORMA del contrato
  // (suma cero), y responde 422 `SETTLEMENT_NOT_ZERO_SUM`, no 400.
  @ApiProperty({ type: [SettleStakeEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SettleStakeEntryDto)
  settlements!: SettleStakeEntryDto[]
}

export class SettleStakeResultDto {
  @ApiProperty() playerId!: string
  @ApiProperty() holdId!: string
  @ApiProperty() balance!: number
  @ApiProperty() reserved!: number
  @ApiProperty() available!: number
}

export class SettleStakesResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() applied!: boolean
  @ApiProperty({ type: [SettleStakeResultDto] })
  results!: SettleStakeResultDto[]
}
