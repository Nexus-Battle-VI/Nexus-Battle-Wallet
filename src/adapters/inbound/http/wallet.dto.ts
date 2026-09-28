import { ApiProperty } from '@nestjs/swagger'
import {
  Allow,
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

/** Combat -> Wallet, `POST /api/internal/v1/wallet/credits/battle-reward` (hu-22-reward-contract-v1 S3). */
export class CreditBattleRewardRequestDto {
  @ApiProperty({ example: 'battle:room-1:player:sub-1:credit' })
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

  @ApiProperty({ example: 'BATTLE_REWARD' })
  @IsString()
  @IsIn(['BATTLE_REWARD'])
  reason!: string

  // El catalogo CERRADO {1,2,4} es una regla de negocio (S3 del contrato:
  // Wallet no confia en que Combat calcule bien el derecho de HU-21) y
  // responde 422, no 400: la valida `assertValidBattleRewardAmounts` en el
  // dominio, no esta anotacion. Aqui solo se exige forma razonable.
  @ApiProperty({ example: 2, minimum: 1, maximum: 4 })
  @IsInt()
  @Min(1)
  @Max(4)
  creditsAmount!: number

  @ApiProperty({ example: 2, minimum: 0, maximum: 4 })
  @IsInt()
  @Min(0)
  @Max(4)
  victoryCreditsAmount!: number

  @ApiProperty({ example: '2026-09-22T10:06:00.000Z' })
  @IsDateString()
  occurredAt!: string
}

export class CreditBattleRewardResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty() applied!: boolean
  @ApiProperty() balance!: number
  @ApiProperty() victoryProgress!: number
  @ApiProperty() weeklyChestCount!: number
  @ApiProperty() weeklyChestLimit!: number
  @ApiProperty() weekIdentity!: string
  @ApiProperty() chestEarned!: boolean
}

/** Web -> Wallet, `GET /api/v1/wallet/me` (hu-22-reward-contract-v1 S4 + HU-23 §6). */
export class WalletSnapshotResponseDto {
  @ApiProperty() balance!: number
  @ApiProperty() reserved!: number
  @ApiProperty() available!: number
  @ApiProperty() victoryProgress!: number
  @ApiProperty() weeklyChestCount!: number
  @ApiProperty() weeklyChestLimit!: number
  @ApiProperty() threshold!: number
}

/**
 * Missions -> Wallet, `POST /api/internal/v1/wallet/credits/mission-reward`
 * (`hu-10-mission-completion-reward-v1` §9.2, HU-10.3).
 *
 * `@Allow()` SOLO DECLARA LOS CAMPOS ANTE EL `ValidationPipe` (`whitelist`): un
 * campo que el contrato no declara sigue siendo `400`. La VALIDACION de cada
 * campo la hace `CreditMissionReward`, porque es quien puede responder con el
 * `code` del contrato (`400 SCHEMA_INVALID` para un cuerpo mal formado, `422
 * MISSION_REWARD_INVALID` para un importe que incumple una regla); un decorador
 * aqui saldria con el cuerpo estandar de Nest, sin `code`.
 */
export class CreditMissionRewardRequestDto {
  @ApiProperty({ enum: [1] }) @Allow() schemaVersion!: unknown

  @ApiProperty({ example: 'mission:enr_01JB8Y3K7Q:reward:guaranteed:credits' })
  @Allow()
  operationId!: unknown

  @ApiProperty({ description: 'Jugador de la matricula. Nunca lo elige un cliente.' })
  @Allow()
  playerId!: unknown

  @ApiProperty({ enum: ['MISSION_REWARD'] }) @Allow() reason!: unknown
  @ApiProperty() @Allow() enrollmentId!: unknown
  @ApiProperty() @Allow() missionId!: unknown

  @ApiProperty({ enum: ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'] })
  @Allow()
  difficulty!: unknown

  @ApiProperty({ example: 'guaranteed:credits' }) @Allow() rewardKey!: unknown

  @ApiProperty({
    minimum: 1,
    description:
      'Entero congelado por Missions. Wallet no decide cuantos creditos vale una mision.',
  })
  @Allow()
  creditsAmount!: unknown

  @ApiProperty({ description: 'El `settledAt` congelado de Missions; identico en cada reintento.' })
  @Allow()
  occurredAt!: unknown
}

/** Respuesta minima: sin victoryProgress, weeklyChestCount, weekIdentity ni chestEarned. */
export class CreditMissionRewardResponseDto {
  @ApiProperty() operationId!: string
  @ApiProperty({ description: '`false` en el replay de una operacion ya aplicada.' })
  applied!: boolean

  @ApiProperty() balance!: number
}
