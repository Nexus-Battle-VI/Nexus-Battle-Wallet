import {
  InvalidTournamentEntryFeeAmountError,
  TournamentEntryFeeInsufficientBalanceError,
} from '../errors/TournamentEntryFeeError'
import type { ClockPort } from '../ports/ClockPort'
import type {
  TournamentEntryFeeRepositoryPort,
  TournamentEntryFeeResult,
} from '../ports/TournamentEntryFeeRepositoryPort'

export class TournamentEntryFees {
  constructor(
    private readonly repository: TournamentEntryFeeRepositoryPort,
    private readonly clock: ClockPort,
  ) {}
  async charge(input: {
    operationId: string
    tournamentId: string
    teamId: string
    payerId: string
    amount: number
  }): Promise<TournamentEntryFeeResult> {
    if (
      !validIdentifier(input.operationId) ||
      !validIdentifier(input.payerId) ||
      !validIdentifier(input.tournamentId) ||
      !validIdentifier(input.teamId) ||
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0
    )
      throw new InvalidTournamentEntryFeeAmountError()
    const result = await this.repository.charge({ ...input, now: this.clock.now() })
    if (result.status === 'REJECTED') throw new TournamentEntryFeeInsufficientBalanceError()
    return result
  }
  async refund(input: {
    operationId: string
    chargeId: string
  }): Promise<TournamentEntryFeeResult> {
    if (!validIdentifier(input.operationId) || !validIdentifier(input.chargeId))
      throw new InvalidTournamentEntryFeeAmountError()
    return this.repository.refund({ ...input, now: this.clock.now() })
  }
}
export const TOURNAMENT_ENTRY_FEES = Symbol('TournamentEntryFees')

const validIdentifier = (value: string): boolean => value.trim().length > 0 && value.length <= 200
