import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  ValidationPipe,
} from '@nestjs/common'
import { ApiBody, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger'
import {
  CREDIT_TOURNAMENT_PRIZE,
  CreditTournamentPrize,
} from '../../../application/use-cases/CreditTournamentPrize'
import type { TournamentCreditsPrizeReceipt } from '../../../application/ports/TournamentPrizeRepositoryPort'
import { InternalOnly } from './auth/decorators'
import { toTournamentPrizeHttpException } from './wallet-error.mapper'
import { CreditTournamentPrizeDto, TournamentPrizeReceiptDto } from './wallet-tournament-prize.dto'

@ApiTags('Tournament prizes')
@ApiHeader({
  name: 'x-internal-service',
  required: true,
  schema: { type: 'string', enum: ['tournament'] },
})
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@InternalOnly('tournament')
@Controller('internal/v1/wallet/credits/tournament-prize')
export class WalletTournamentPrizeController {
  constructor(@Inject(CREDIT_TOURNAMENT_PRIZE) private readonly credit: CreditTournamentPrize) {}
  @Post()
  @HttpCode(200)
  @ApiBody({ type: CreditTournamentPrizeDto })
  @ApiOkResponse({
    type: TournamentPrizeReceiptDto,
    description: 'Primera entrega o replay del mismo derecho y recibo.',
  })
  @ApiResponse({
    status: 400,
    description: 'SCHEMA_INVALID: tipos, campos desconocidos o referencias mal formadas.',
  })
  @ApiResponse({
    status: 401,
    description: 'HMAC ausente/incorrecto/caducado o consumidor distinto de tournament.',
  })
  @ApiResponse({
    status: 409,
    description: 'OPERATION_ID_REUSED: id de Tournament con otro propósito.',
  })
  @ApiResponse({
    status: 422,
    description: 'PRIZE_INVALID: importe no canónico o fuera del rango.',
  })
  @ApiResponse({
    status: 503,
    description:
      'PRIZE_DEPENDENCY_UNAVAILABLE: persistencia no durable/no disponible; reintentar el mismo derecho. Sin secreto HMAC, el guard deniega con 503.',
  })
  async grant(
    @Body(
      new ValidationPipe({
        expectedType: CreditTournamentPrizeDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: () =>
          new BadRequestException({
            statusCode: 400,
            code: 'SCHEMA_INVALID',
            message: 'El derecho no cumple el contrato de premio.',
          }),
      }),
    )
    body: unknown,
  ): Promise<TournamentCreditsPrizeReceipt> {
    try {
      return await this.credit.execute(body)
    } catch (error: unknown) {
      throw toTournamentPrizeHttpException(error)
    }
  }
}
