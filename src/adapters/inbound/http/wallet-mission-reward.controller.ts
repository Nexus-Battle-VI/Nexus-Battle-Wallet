import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  CREDIT_MISSION_REWARD,
  CreditMissionReward,
} from '../../../application/use-cases/CreditMissionReward'
import { InternalOnly } from './auth/decorators'
import { CreditMissionRewardRequestDto, CreditMissionRewardResponseDto } from './wallet.dto'
import { toWalletHttpException } from './wallet-error.mapper'

/**
 * Contrato interno Missions -> Wallet (`hu-10-mission-completion-reward-v1` §9,
 * Task HU-10.3): creditos de finalizacion de mision.
 *
 * SOLO `missions`. La ruta hermana de batalla (`battle-reward`) es SOLO de
 * `combat`: una mision no es una victoria JcJ, y esta operacion no toca el
 * progreso de victoria, los cofres ni la semana. La lista de servicios se declara
 * por ruta (`@InternalOnly('missions')`) sobre la lista global de ADR-019, y el
 * guard global exige antes la firma HMAC, el sello y el secreto (falla cerrado).
 *
 * NO HAY RUTA PUBLICA: ningun cliente puede acreditar ni elegir beneficiario.
 */
@ApiTags('wallet-internal')
@InternalOnly('missions')
@Controller('internal/v1/wallet/credits')
export class WalletMissionRewardController {
  constructor(
    @Inject(CREDIT_MISSION_REWARD) private readonly creditMissionReward: CreditMissionReward,
  ) {}

  @Post('mission-reward')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acredita creditos de finalizacion de mision, una sola vez por operationId (HU-10)',
    description:
      'Incrementa solo el saldo. No modifica victoryProgress, weeklyChestCount ni la semana, ' +
      'y no evalua cofres. El importe llega congelado desde Missions; Wallet no lo decide.',
  })
  async missionReward(
    @Body() body: CreditMissionRewardRequestDto,
  ): Promise<CreditMissionRewardResponseDto> {
    try {
      return await this.creditMissionReward.execute(body)
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
