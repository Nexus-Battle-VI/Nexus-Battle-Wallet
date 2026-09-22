import { ApiProperty } from '@nestjs/swagger'
import {
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

/** Web -> Wallet, `GET /api/v1/wallet/me` (hu-22-reward-contract-v1 S4). */
export class WalletSnapshotResponseDto {
  @ApiProperty() balance!: number
  @ApiProperty() victoryProgress!: number
  @ApiProperty() weeklyChestCount!: number
  @ApiProperty() weeklyChestLimit!: number
  @ApiProperty() threshold!: number
}
