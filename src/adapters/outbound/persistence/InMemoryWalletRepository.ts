import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  CreditBattleRewardCommand,
  CreditBattleRewardResult,
  WalletRepositoryPort,
  WalletSnapshot,
} from '../../../application/ports/WalletRepositoryPort'
import { WEEKLY_CHEST_LIMIT } from '../../../domain/policies/ChestEligibilityPolicy'
import { computeNextWalletState } from '../../../application/services/WalletStateTransition'
import { InMemoryWalletStore } from './InMemoryWalletStore'

/**
 * Doble de pruebas/desarrollo (`PERSISTENCE_DRIVER=memory`). Reproduce la
 * misma semantica de idempotencia y de transicion de estado que
 * `PostgresWalletRepository`, sin bloqueo real: Node es de un solo hilo, y
 * esta clase no se usa en produccion (ADR-019, el andamiaje ya lo impide).
 *
 * Comparte `InMemoryWalletStore` con `InMemoryStakeRepository` para que
 * `reserved`/`available` sean los mismos desde cualquier lectura.
 */
export class InMemoryWalletRepository implements WalletRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}

  // `async` a proposito: un `throw` sincrono en un metodo NO async que declara
  // devolver `Promise<T>` escapa como excepcion sincrona en lugar de rechazar
  // la promesa (rompe `await x().catch(...)` y `expect(...).rejects`).
  // eslint-disable-next-line @typescript-eslint/require-await
  async creditBattleReward(
    command: CreditBattleRewardCommand,
    currentWeekIdentity: string,
  ): Promise<CreditBattleRewardResult> {
    const existing = this.store.rewardLedger.get(command.operationId)

    if (existing !== undefined) {
      // Misma regla que `PostgresWalletRepository`: la intencion completa del
      // contrato, `reason` y `occurredAt` incluidos (comparado por valor, no
      // por identidad de objeto).
      const sameIntent =
        existing.playerId === command.playerId &&
        existing.battleId === command.battleId &&
        existing.reason === command.reason &&
        existing.creditsAmount === command.creditsAmount &&
        existing.victoryCreditsAmount === command.victoryCreditsAmount &&
        existing.occurredAt.getTime() === command.occurredAt.getTime()

      if (!sameIntent) {
        throw new OperationConflictError(command.operationId)
      }

      return { ...existing.result, applied: false }
    }

    const stored = this.store.accounts.get(command.playerId) ?? {
      balance: 0,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: currentWeekIdentity,
    }

    const next = computeNextWalletState(
      stored,
      currentWeekIdentity,
      command.creditsAmount,
      command.victoryCreditsAmount,
    )

    this.store.accounts.set(command.playerId, {
      balance: next.balance,
      // Reservar no toca `balance`; acreditar no toca `reserved`.
      reserved: stored.reserved,
      victoryProgress: next.victoryProgress,
      weeklyChestCount: next.weeklyChestCount,
      weekIdentity: next.weekIdentity,
    })

    const result: CreditBattleRewardResult = {
      operationId: command.operationId,
      applied: true,
      balance: next.balance,
      victoryProgress: next.victoryProgress,
      weeklyChestCount: next.weeklyChestCount,
      weeklyChestLimit: WEEKLY_CHEST_LIMIT,
      weekIdentity: next.weekIdentity,
      chestEarned: next.chestEarned,
    }

    this.store.rewardLedger.set(command.operationId, {
      operationId: command.operationId,
      playerId: command.playerId,
      battleId: command.battleId,
      reason: command.reason,
      creditsAmount: command.creditsAmount,
      victoryCreditsAmount: command.victoryCreditsAmount,
      occurredAt: command.occurredAt,
      result,
    })

    return result
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSnapshot(playerId: string, currentWeekIdentity: string): Promise<WalletSnapshot> {
    const stored = this.store.accounts.get(playerId)

    if (stored === undefined) {
      return {
        balance: 0,
        reserved: 0,
        available: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weeklyChestLimit: WEEKLY_CHEST_LIMIT,
        weekIdentity: currentWeekIdentity,
      }
    }

    const weeklyChestCount =
      stored.weekIdentity === currentWeekIdentity ? stored.weeklyChestCount : 0

    return {
      balance: stored.balance,
      reserved: stored.reserved,
      available: stored.balance - stored.reserved,
      victoryProgress: stored.victoryProgress,
      weeklyChestCount,
      weeklyChestLimit: WEEKLY_CHEST_LIMIT,
      weekIdentity: currentWeekIdentity,
    }
  }
}
