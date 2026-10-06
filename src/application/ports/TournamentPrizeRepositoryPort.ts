/** Derecho autorizado por Tournament; Wallet no determina campeón ni reparto. */
export interface TournamentCreditsPrize {
  readonly operationId: string
  readonly tournamentId: string
  readonly championTeamId: string
  readonly finalEncounterId: string
  readonly finalRoomId: string
  readonly playerId: string
  readonly heroId: string
  readonly kind: 'CREDITS'
  /** Entero decimal canónico. Nunca convertir a Number para acreditar. */
  readonly amount: string
  readonly productId: null
}

export interface TournamentCreditsPrizeReceipt extends TournamentCreditsPrize {
  readonly status: 'DELIVERED'
  readonly receiptId: string
}

export interface TournamentPrizeRepositoryPort {
  credit(command: TournamentCreditsPrize, now: Date): Promise<TournamentCreditsPrizeReceipt>
}

export const TOURNAMENT_PRIZE_REPOSITORY = Symbol('TournamentPrizeRepository')
