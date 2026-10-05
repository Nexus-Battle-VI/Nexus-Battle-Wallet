import { TournamentEntryFeeNotFoundError } from '../../../application/errors/TournamentEntryFeeError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  TournamentEntryFeeRepositoryPort,
  TournamentEntryFeeResult,
  ChargeTournamentEntryFee,
  RefundTournamentEntryFee,
} from '../../../application/ports/TournamentEntryFeeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { InMemoryWalletStore, type InMemoryAccountState } from './InMemoryWalletStore'

export class InMemoryTournamentEntryFeeRepository implements TournamentEntryFeeRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async charge(command: ChargeTournamentEntryFee): Promise<TournamentEntryFeeResult> {
    if (this.store.entryFeeRefunds.has(command.operationId)) {
      throw new OperationConflictError(command.operationId)
    }
    const intent = JSON.stringify([
      'charge',
      command.tournamentId,
      command.teamId,
      command.payerId,
      command.amount,
    ])
    const replay = this.store.entryFeeOperations.get(command.operationId)
    if (replay) {
      if (replay.intent !== intent) throw new OperationConflictError(command.operationId)
      return {
        ...replay.result,
        status: this.store.entryFees.get(replay.result.chargeId)?.status ?? replay.result.status,
        applied: false,
      }
    }
    const account = this.account(command.payerId, command.now)
    if (account.balance - account.reserved < command.amount) {
      const result: TournamentEntryFeeResult = {
        operationId: command.operationId,
        tournamentId: command.tournamentId,
        teamId: command.teamId,
        payerId: command.payerId,
        amount: command.amount,
        chargeId: command.operationId,
        status: 'REJECTED',
        applied: false,
      }
      this.store.entryFees.set(command.operationId, result)
      this.store.entryFeeOperations.set(command.operationId, { intent, result })
      return result
    }
    account.balance -= command.amount
    const result: TournamentEntryFeeResult = {
      operationId: command.operationId,
      chargeId: command.operationId,
      payerId: command.payerId,
      tournamentId: command.tournamentId,
      teamId: command.teamId,
      amount: command.amount,
      status: 'CHARGED',
      applied: true,
    }
    this.store.entryFees.set(result.chargeId, { ...result })
    this.store.entryFeeOperations.set(command.operationId, { intent, result })
    this.store.entryFeeLedger.set(command.operationId, {
      chargeId: result.chargeId,
      kind: 'CHARGE',
      amount: command.amount,
      resultingBalance: account.balance,
    })
    return result
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(command: RefundTournamentEntryFee): Promise<TournamentEntryFeeResult> {
    if (this.store.entryFeeOperations.has(command.operationId)) {
      throw new OperationConflictError(command.operationId)
    }
    const previousChargeId = this.store.entryFeeRefunds.get(command.operationId)
    if (previousChargeId !== undefined) {
      if (previousChargeId !== command.chargeId)
        throw new OperationConflictError(command.operationId)
      const replay = this.store.entryFees.get(command.chargeId)
      if (!replay) throw new TournamentEntryFeeNotFoundError(command.chargeId)
      return { ...replay, operationId: command.operationId, applied: false }
    }
    const fee = this.store.entryFees.get(command.chargeId)
    if (!fee || fee.status === 'REJECTED')
      throw new TournamentEntryFeeNotFoundError(command.chargeId)
    this.store.entryFeeRefunds.set(command.operationId, command.chargeId)
    if (fee.status === 'REFUNDED')
      return {
        operationId: command.operationId,
        chargeId: fee.chargeId,
        payerId: fee.payerId,
        tournamentId: fee.tournamentId,
        teamId: fee.teamId,
        amount: fee.amount,
        status: 'REFUNDED',
        applied: false,
      }
    const account = this.account(fee.payerId, command.now)
    account.balance += fee.amount
    fee.status = 'REFUNDED'
    this.store.entryFeeLedger.set(command.operationId, {
      chargeId: fee.chargeId,
      kind: 'REFUND',
      amount: fee.amount,
      resultingBalance: account.balance,
    })
    const result: TournamentEntryFeeResult = {
      operationId: command.operationId,
      chargeId: fee.chargeId,
      payerId: fee.payerId,
      tournamentId: fee.tournamentId,
      teamId: fee.teamId,
      amount: fee.amount,
      status: 'REFUNDED',
      applied: true,
    }
    return result
  }
  private account(playerId: string, now: Date): InMemoryAccountState {
    const found = this.store.accounts.get(playerId)
    if (found) return found
    const created = {
      balance: 0,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: weekIdentityOf(now),
    }
    this.store.accounts.set(playerId, created)
    return created
  }
}
