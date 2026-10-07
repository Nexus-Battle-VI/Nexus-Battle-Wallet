import type { TournamentCreditsPrize } from '../../src/application/ports/TournamentPrizeRepositoryPort'

/** Fixture QA exclusivamente: no representa una final jugada ni un reparto aprobado. */
export const qaTournamentPrize = (id: string): TournamentCreditsPrize => ({
  operationId: `qa:wallet:prize:${id}`,
  tournamentId: 'qa-tournament-hu86',
  championTeamId: 'qa-champion-team',
  finalEncounterId: 'qa-final-encounter-opaque-id',
  finalRoomId: 'qa-final-room',
  playerId: `qa-player-${id}`,
  heroId: `qa-hero-${id}`,
  kind: 'CREDITS',
  amount: '501',
  productId: null,
})
