import { Controller, Get, Inject } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import {
  GET_WALLET_SNAPSHOT,
  GetWalletSnapshot,
} from '../../../application/use-cases/GetWalletSnapshot'
import { CurrentIdentity, Roles } from './auth/decorators'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { WalletSnapshotResponseDto } from './wallet.dto'

/**
 * Primer endpoint de negocio publico de Wallet (hu-22-reward-contract-v1, S4).
 * `playerId` sale SIEMPRE del testimonio verificado (`subject`), nunca de un
 * parametro que el cliente pueda elegir.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('v1/wallet')
export class WalletController {
  constructor(@Inject(GET_WALLET_SNAPSHOT) private readonly getWalletSnapshot: GetWalletSnapshot) {}

  @Get('me')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Saldo, progreso de cofre y limite semanal del jugador autenticado' })
  @ApiOkResponse({ type: WalletSnapshotResponseDto })
  async me(@CurrentIdentity() identity: VerifiedIdentity): Promise<WalletSnapshotResponseDto> {
    return this.getWalletSnapshot.execute(identity.subject)
  }
}
