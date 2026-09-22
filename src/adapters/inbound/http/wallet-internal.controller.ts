import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  CREDIT_BATTLE_REWARD,
  CreditBattleReward,
} from '../../../application/use-cases/CreditBattleReward'
import type { CreditBattleRewardResult } from '../../../application/ports/WalletRepositoryPort'
import { InternalOnly } from './auth/decorators'
import { CreditBattleRewardRequestDto, CreditBattleRewardResponseDto } from './wallet.dto'
import { toWalletHttpException } from './wallet-error.mapper'

/**
 * Contrato interno Combat -> Wallet (hu-22-reward-contract-v1, S3). Solo
 * `combat` esta en `INTERNAL_CALLERS`; el guard global de firma HMAC ya lo
 * exige antes de llegar aqui.
 */
@ApiTags('wallet-internal')
@InternalOnly()
@Controller('internal/v1/wallet/credits')
export class WalletInternalController {
  constructor(
    @Inject(CREDIT_BATTLE_REWARD) private readonly creditBattleReward: CreditBattleReward,
  ) {}

  @Post('battle-reward')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acredita el derecho de creditos de HU-21 y evalua el cofre de HU-22' })
  async battleReward(
    @Body() body: CreditBattleRewardRequestDto,
  ): Promise<CreditBattleRewardResponseDto> {
    try {
      const result: CreditBattleRewardResult = await this.creditBattleReward.execute({
        operationId: body.operationId,
        playerId: body.playerId,
        battleId: body.battleId,
        reason: body.reason,
        creditsAmount: body.creditsAmount,
        victoryCreditsAmount: body.victoryCreditsAmount,
        occurredAt: new Date(body.occurredAt),
      })

      return result
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
