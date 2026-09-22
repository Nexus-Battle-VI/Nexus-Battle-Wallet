import {
  HoldAmountMismatchError,
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
  SettlementNotZeroSumError,
} from '../../../application/errors/StakePersistenceError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  ReleaseStakeCommand,
  ReserveStakeCommand,
  SettleStakesCommand,
  SettleStakesResult,
  StakeOperationResult,
  StakeRepositoryPort,
  StakeSettlementResult,
} from '../../../application/ports/StakeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { STAKE_HOLD_TTL_MS } from './PostgresStakeRepository'
import {
  InMemoryWalletStore,
  type InMemoryAccountState,
  type InMemoryStakeHold,
  type InMemoryStakeLedgerEntry,
} from './InMemoryWalletStore'

/**
 * Doble de pruebas/desarrollo de las apuestas (`PERSISTENCE_DRIVER=memory`).
 *
 * Reproduce la misma semantica observable que `PostgresStakeRepository`
 * (idempotencia por `operationId`, liberacion por estado, suma cero) sin
 * bloqueo real: Node es de un solo hilo y esta clase no se usa en produccion.
 * Comparte el almacen con `InMemoryWalletRepository`, de modo que
 * `GET /wallet/me` ve las reservas hechas aqui.
 */
export class InMemoryStakeRepository implements StakeRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}

  // `async` a proposito: un `throw` sincrono escaparia como excepcion en lugar
  // de rechazar la promesa.
  // eslint-disable-next-line @typescript-eslint/require-await
  async reserve(command: ReserveStakeCommand, clockNow: Date): Promise<StakeOperationResult> {
    const existingHold = this.store.stakeHolds.get(command.operationId)

    if (existingHold !== undefined) {
      const sameIntent =
        existingHold.playerId === command.playerId &&
        existingHold.battleId === command.battleId &&
        existingHold.amount === command.amount

      if (!sameIntent) {
        throw new OperationConflictError(command.operationId)
      }

      const ledgerRow = (this.store.stakeLedger.get(command.operationId) ?? []).find(
        (entry) => entry.kind === 'RESERVE',
      )

      if (ledgerRow === undefined) {
        throw new Error('Estado inconsistente del almacen en memoria: hold sin movimiento.')
      }

      return {
        operationId: command.operationId,
        applied: false,
        holdId: command.operationId,
        balance: ledgerRow.resultingBalance,
        reserved: ledgerRow.resultingReserved,
        available: ledgerRow.resultingBalance - ledgerRow.resultingReserved,
      }
    }

    const account = this.accountOf(command.playerId, clockNow)
    const available = account.balance - account.reserved

    if (available < command.amount) {
      throw new InsufficientAvailableBalanceError(command.playerId, available, command.amount)
    }

    account.reserved += command.amount

    this.store.stakeHolds.set(command.operationId, {
      operationId: command.operationId,
      playerId: command.playerId,
      battleId: command.battleId,
      amount: command.amount,
      status: 'ACTIVE',
      createdAt: clockNow,
      updatedAt: clockNow,
      expiresAt: new Date(clockNow.getTime() + STAKE_HOLD_TTL_MS),
    })

    this.store.stakeLedger.set(command.operationId, [
      {
        operationId: command.operationId,
        kind: 'RESERVE',
        holdOperationId: command.operationId,
        playerId: command.playerId,
        battleId: command.battleId,
        amount: command.amount,
        resultingBalance: account.balance,
        resultingReserved: account.reserved,
        createdAt: clockNow,
      },
    ])

    return {
      operationId: command.operationId,
      applied: true,
      holdId: command.operationId,
      balance: account.balance,
      reserved: account.reserved,
      available: account.balance - account.reserved,
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async release(command: ReleaseStakeCommand): Promise<StakeOperationResult> {
    const existingEntry = (this.store.stakeLedger.get(command.operationId) ?? [])[0]

    if (existingEntry !== undefined) {
      if (existingEntry.holdOperationId !== command.holdId) {
        throw new OperationConflictError(command.operationId)
      }

      return {
        operationId: command.operationId,
        applied: false,
        holdId: command.holdId,
        balance: existingEntry.resultingBalance,
        reserved: existingEntry.resultingReserved,
        available: existingEntry.resultingBalance - existingEntry.resultingReserved,
      }
    }

    const hold = this.store.stakeHolds.get(command.holdId)

    if (hold === undefined) {
      throw new HoldNotFoundError(command.holdId)
    }

    const now = new Date()
    const account = this.accountOf(hold.playerId, now)

    if (hold.status !== 'ACTIVE') {
      return {
        operationId: command.operationId,
        applied: false,
        holdId: command.holdId,
        balance: account.balance,
        reserved: account.reserved,
        available: account.balance - account.reserved,
      }
    }

    account.reserved -= hold.amount
    hold.status = 'RELEASED'
    hold.updatedAt = now

    this.store.stakeLedger.set(command.operationId, [
      {
        operationId: command.operationId,
        kind: 'RELEASE',
        holdOperationId: command.holdId,
        playerId: hold.playerId,
        battleId: hold.battleId,
        amount: hold.amount,
        resultingBalance: account.balance,
        resultingReserved: account.reserved,
        createdAt: now,
      },
    ])

    return {
      operationId: command.operationId,
      applied: true,
      holdId: command.holdId,
      balance: account.balance,
      reserved: account.reserved,
      available: account.balance - account.reserved,
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async settle(command: SettleStakesCommand): Promise<SettleStakesResult> {
    const existingEntries = this.store.stakeLedger.get(command.operationId)

    if (existingEntries !== undefined) {
      if (!sameSettlementIntent(existingEntries, command)) {
        throw new OperationConflictError(command.operationId)
      }

      return {
        operationId: command.operationId,
        applied: false,
        results: existingEntries.map((entry) => ({
          playerId: entry.playerId,
          holdId: entry.holdOperationId,
          balance: entry.resultingBalance,
          reserved: entry.resultingReserved,
          available: entry.resultingBalance - entry.resultingReserved,
        })),
      }
    }

    // El doble en memoria no tiene transaccion que revierta: se valida TODO
    // antes de tocar nada. Es la misma garantia observable que da el
    // rollback de PostgreSQL.
    let capturedTotal = 0
    let creditedTotal = 0

    for (const entry of command.settlements) {
      if (entry.outcome === 'CAPTURED') {
        capturedTotal += entry.amount
      } else {
        creditedTotal += entry.amount
      }
    }

    if (capturedTotal !== creditedTotal) {
      throw new SettlementNotZeroSumError(
        `se capturan ${String(capturedTotal)} y se acreditan ${String(creditedTotal)}.`,
      )
    }

    const seenHolds = new Set<string>()
    const holds = new Map<string, InMemoryStakeHold>()

    for (const entry of command.settlements) {
      // Un hold repetido en la misma liquidacion es el caso que en PostgreSQL
      // falla en la segunda pasada (ya no esta ACTIVE); aqui se detecta antes.
      if (seenHolds.has(entry.holdId)) {
        throw new HoldNotFoundError(entry.holdId)
      }
      seenHolds.add(entry.holdId)

      const hold = this.store.stakeHolds.get(entry.holdId)

      if (
        hold?.playerId !== entry.playerId ||
        hold.battleId !== command.battleId ||
        hold.status !== 'ACTIVE'
      ) {
        throw new HoldNotFoundError(entry.holdId)
      }

      if (entry.outcome === 'CAPTURED' && hold.amount !== entry.amount) {
        throw new HoldAmountMismatchError(entry.holdId, hold.amount, entry.amount)
      }

      holds.set(entry.holdId, hold)
    }

    const now = new Date()
    const rows: InMemoryStakeLedgerEntry[] = []
    const results: StakeSettlementResult[] = []

    for (const entry of command.settlements) {
      const hold = holds.get(entry.holdId)
      if (hold === undefined) {
        throw new Error('Estado inconsistente del almacen en memoria: hold validado sin fila.')
      }

      const account = this.accountOf(entry.playerId, now)

      if (entry.outcome === 'CAPTURED') {
        account.balance -= entry.amount
      } else {
        account.balance += entry.amount
      }
      account.reserved -= hold.amount
      hold.status = entry.outcome === 'CAPTURED' ? 'CAPTURED' : 'RELEASED'
      hold.updatedAt = now

      rows.push({
        operationId: command.operationId,
        kind: entry.outcome === 'CAPTURED' ? 'SETTLE_CAPTURE' : 'SETTLE_CREDIT',
        holdOperationId: entry.holdId,
        playerId: entry.playerId,
        battleId: command.battleId,
        amount: entry.amount,
        resultingBalance: account.balance,
        resultingReserved: account.reserved,
        createdAt: now,
      })

      results.push({
        playerId: entry.playerId,
        holdId: entry.holdId,
        balance: account.balance,
        reserved: account.reserved,
        available: account.balance - account.reserved,
      })
    }

    this.store.stakeLedger.set(command.operationId, rows)

    return { operationId: command.operationId, applied: true, results }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async expireStale(clockNow: Date, limit: number): Promise<number> {
    let expired = 0

    for (const hold of this.store.stakeHolds.values()) {
      if (expired >= limit) {
        break
      }

      if (hold.status !== 'ACTIVE' || hold.expiresAt.getTime() > clockNow.getTime()) {
        continue
      }

      const account = this.accountOf(hold.playerId, clockNow)
      account.reserved -= hold.amount
      hold.status = 'EXPIRED'
      hold.updatedAt = clockNow

      const expireOperationId = `${hold.operationId}:expire`
      if (!this.store.stakeLedger.has(expireOperationId)) {
        this.store.stakeLedger.set(expireOperationId, [
          {
            operationId: expireOperationId,
            kind: 'EXPIRE',
            holdOperationId: hold.operationId,
            playerId: hold.playerId,
            battleId: hold.battleId,
            amount: hold.amount,
            resultingBalance: account.balance,
            resultingReserved: account.reserved,
            createdAt: clockNow,
          },
        ])
      }

      expired += 1
    }

    return expired
  }

  private accountOf(playerId: string, now: Date): InMemoryAccountState {
    const existing = this.store.accounts.get(playerId)

    if (existing !== undefined) {
      return existing
    }

    const created: InMemoryAccountState = {
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

const sameSettlementIntent = (
  stored: readonly InMemoryStakeLedgerEntry[],
  command: SettleStakesCommand,
): boolean => {
  if (stored.length !== command.settlements.length) {
    return false
  }

  const keyOf = (playerId: string, holdId: string, kind: string, amount: number): string =>
    `${playerId}\u0000${holdId}\u0000${kind}\u0000${String(amount)}`

  const storedKeys = new Set(
    stored.map((entry) => keyOf(entry.playerId, entry.holdOperationId, entry.kind, entry.amount)),
  )
  const requestedKeys = new Set(
    command.settlements.map((entry) =>
      keyOf(
        entry.playerId,
        entry.holdId,
        entry.outcome === 'CAPTURED' ? 'SETTLE_CAPTURE' : 'SETTLE_CREDIT',
        entry.amount,
      ),
    ),
  )

  return (
    storedKeys.size === requestedKeys.size && [...storedKeys].every((key) => requestedKeys.has(key))
  )
}
