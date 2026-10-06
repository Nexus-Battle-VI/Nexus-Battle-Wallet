export type TournamentEntryFeeStatus = 'CHARGED' | 'REFUNDED' | 'REJECTED'

export interface TournamentEntryFeeResult {
  readonly operationId: string
  readonly chargeId: string
  readonly tournamentId: string
  readonly teamId: string
  readonly payerId: string
  readonly amount: number
  readonly status: TournamentEntryFeeStatus
  readonly applied: boolean
}

export interface ChargeTournamentEntryFee {
  readonly operationId: string
  readonly tournamentId: string
  readonly teamId: string
  readonly payerId: string
  readonly amount: number
  readonly now: Date
}

export interface RefundTournamentEntryFee {
  readonly operationId: string
  readonly chargeId: string
  readonly now: Date
}

export interface TournamentEntryFeeRepositoryPort {
  charge(command: ChargeTournamentEntryFee): Promise<TournamentEntryFeeResult>
  refund(command: RefundTournamentEntryFee): Promise<TournamentEntryFeeResult>
}

export const TOURNAMENT_ENTRY_FEE_REPOSITORY = Symbol('TournamentEntryFeeRepositoryPort')
