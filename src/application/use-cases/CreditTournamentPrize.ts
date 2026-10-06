import {
  InvalidTournamentPrizeError,
  TournamentPrizeSchemaError,
} from '../errors/TournamentPrizeError'
import type { ClockPort } from '../ports/ClockPort'
import type {
  TournamentCreditsPrize,
  TournamentCreditsPrizeReceipt,
  TournamentPrizeRepositoryPort,
} from '../ports/TournamentPrizeRepositoryPort'

const textLimits = {
  operationId: 512,
  tournamentId: 160,
  championTeamId: 160,
  finalEncounterId: 512,
  finalRoomId: 160,
  playerId: 160,
  heroId: 160,
} as const
const fields = [...Object.keys(textLimits), 'kind', 'amount', 'productId']

/** Valida también las llamadas de aplicación que no pasan por Nest/DTO. */
export const normalizeTournamentPrize = (raw: unknown): TournamentCreditsPrize => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TournamentPrizeSchemaError('Se requiere un derecho de premio.')
  const body = raw as Record<string, unknown>
  if (Object.keys(body).length !== fields.length || fields.some((key) => !Object.hasOwn(body, key)))
    throw new TournamentPrizeSchemaError(
      'El derecho debe contener exactamente los diez campos acordados.',
    )
  for (const [key, max] of Object.entries(textLimits)) {
    const value = body[key]
    if (
      typeof value !== 'string' ||
      value.length > max ||
      !/^\S(?:.*\S)?$/.test(value) ||
      value.includes('\0')
    )
      throw new TournamentPrizeSchemaError(
        `${key} debe ser una referencia válida de hasta ${String(max)} caracteres.`,
      )
  }
  if (body.kind !== 'CREDITS' || body.productId !== null || typeof body.amount !== 'string')
    throw new TournamentPrizeSchemaError(
      'Se requiere kind=CREDITS, productId=null y amount como string.',
    )
  if (!/^[1-9][0-9]{0,15}$/.test(body.amount) || BigInt(body.amount) > 9007199254740991n)
    throw new InvalidTournamentPrizeError(
      'amount debe ser un entero decimal canónico entre 1 y 9007199254740991.',
    )
  // Orden y valores estables: no se recortan ids ni se normalizan importes ambiguos.
  return {
    operationId: body.operationId as string,
    tournamentId: body.tournamentId as string,
    championTeamId: body.championTeamId as string,
    finalEncounterId: body.finalEncounterId as string,
    finalRoomId: body.finalRoomId as string,
    playerId: body.playerId as string,
    heroId: body.heroId as string,
    kind: 'CREDITS',
    amount: body.amount,
    productId: null,
  }
}

export class CreditTournamentPrize {
  constructor(
    private readonly repository: TournamentPrizeRepositoryPort,
    private readonly clock: ClockPort,
  ) {}
  execute(input: unknown): Promise<TournamentCreditsPrizeReceipt> {
    return this.repository.credit(normalizeTournamentPrize(input), this.clock.now())
  }
}

export const CREDIT_TOURNAMENT_PRIZE = Symbol('CreditTournamentPrize')
