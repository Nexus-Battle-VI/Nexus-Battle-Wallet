import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  RELEASE_STAKE,
  ReleaseStake,
  type ReleaseStakeInput,
} from '../../../application/use-cases/ReleaseStake'
import {
  RESERVE_STAKE,
  ReserveStake,
  type ReserveStakeInput,
} from '../../../application/use-cases/ReserveStake'
import {
  SETTLE_STAKES,
  SettleStakes,
  type SettleStakesInput,
} from '../../../application/use-cases/SettleStakes'
import { InternalOnly } from './auth/decorators'
import {
  ReleaseStakeRequestDto,
  ReleaseStakeResponseDto,
  ReserveStakeRequestDto,
  ReserveStakeResponseDto,
  SettleStakesRequestDto,
  SettleStakesResponseDto,
} from './wallet-stakes.dto'
import { toWalletHttpException } from './wallet-error.mapper'

/**
 * Contrato interno Combat -> Wallet de apuestas (hu-23-battle-stake-v1 §5).
 * Solo `combat` esta en `INTERNAL_CALLERS`; el guard global de firma HMAC ya
 * lo exige antes de llegar aqui.
 */
@ApiTags('wallet-internal')
@InternalOnly()
@Controller('internal/v1/wallet/stakes')
export class WalletStakesInternalController {
  constructor(
    @Inject(RESERVE_STAKE) private readonly reserveStake: ReserveStake,
    @Inject(RELEASE_STAKE) private readonly releaseStake: ReleaseStake,
    @Inject(SETTLE_STAKES) private readonly settleStakes: SettleStakes,
  ) {}

  @Post('reserve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reserva (hold) el monto de una apuesta; nunca toca el balance' })
  async reserve(@Body() body: ReserveStakeRequestDto): Promise<ReserveStakeResponseDto> {
    try {
      const input: ReserveStakeInput = {
        operationId: body.operationId,
        playerId: body.playerId,
        battleId: body.battleId,
        amount: body.amount,
        occurredAt: new Date(body.occurredAt),
      }

      return await this.reserveStake.execute(input)
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }

  @Post('release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Libera un hold activo; idempotente por operationId y por estado' })
  async release(@Body() body: ReleaseStakeRequestDto): Promise<ReleaseStakeResponseDto> {
    try {
      const input: ReleaseStakeInput = {
        operationId: body.operationId,
        holdId: body.holdId,
        reason: body.reason,
      }

      return await this.releaseStake.execute(input)
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }

  @Post('settle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liquida una batalla con ganador en una sola llamada de suma cero' })
  async settle(@Body() body: SettleStakesRequestDto): Promise<SettleStakesResponseDto> {
    try {
      const input: SettleStakesInput = {
        operationId: body.operationId,
        battleId: body.battleId,
        settlements: body.settlements.map((entry) => ({
          playerId: entry.playerId,
          holdId: entry.holdId,
          outcome: entry.outcome,
          amount: entry.amount,
        })),
      }

      const result = await this.settleStakes.execute(input)

      return {
        operationId: result.operationId,
        applied: result.applied,
        results: [...result.results],
      }
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
