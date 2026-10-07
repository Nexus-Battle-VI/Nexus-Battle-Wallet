import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import {
  TOURNAMENT_ENTRY_FEES,
  TournamentEntryFees,
} from '../../../application/use-cases/TournamentEntryFees'
import { InternalOnly } from './auth/decorators'
import { toWalletHttpException } from './wallet-error.mapper'
import {
  TournamentEntryFeeResponseDto,
  ChargeTournamentEntryFeeDto,
  RefundTournamentEntryFeeDto,
} from './wallet-tournament-entry-fees.dto'
@InternalOnly('tournament')
@Controller('internal/v1/wallet/tournament-entry-fees')
export class WalletTournamentEntryFeesController {
  constructor(@Inject(TOURNAMENT_ENTRY_FEES) private readonly fees: TournamentEntryFees) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  async charge(@Body() body: ChargeTournamentEntryFeeDto): Promise<TournamentEntryFeeResponseDto> {
    try {
      return await this.fees.charge(body)
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
  @Post(':chargeId/refunds')
  @HttpCode(HttpStatus.OK)
  async refund(
    @Param('chargeId') chargeId: string,
    @Body() body: RefundTournamentEntryFeeDto,
  ): Promise<TournamentEntryFeeResponseDto> {
    try {
      return await this.fees.refund({ operationId: body.operationId, chargeId })
    } catch (error: unknown) {
      throw toWalletHttpException(error)
    }
  }
}
