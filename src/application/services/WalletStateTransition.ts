import { applyVictoryCredits } from '../../domain/policies/ChestEligibilityPolicy'

export interface StoredWalletState {
  readonly balance: number
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly weekIdentity: string
}

export interface WalletTransitionResult {
  readonly balance: number
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly weekIdentity: string
  readonly chestEarned: boolean
}

/**
 * Un unico punto de calculo del "siguiente estado" de una cuenta de Wallet,
 * para que el adaptador de PostgreSQL y el de memoria (pruebas/desarrollo)
 * apliquen EXACTAMENTE la misma regla de negocio. Ninguno de los dos
 * reimplementa el rollover semanal ni `ChestEligibilityPolicy` por su cuenta.
 *
 * Rollover perezoso (HU-22 S36 del prompt): si la semana actual no coincide
 * con la almacenada, el contador semanal de cofres vuelve a 0 ANTES de
 * evaluar el credito de esta operacion. El progreso de victoria NO se toca
 * por el rollover en si (solo lo congela/resetea `ChestEligibilityPolicy`
 * cuando ya se alcanzaron 2/2 cofres).
 */
export const computeNextWalletState = (
  stored: StoredWalletState,
  currentWeekIdentity: string,
  creditsAmount: number,
  victoryCreditsAmount: number,
): WalletTransitionResult => {
  const weeklyChestCount = stored.weekIdentity === currentWeekIdentity ? stored.weeklyChestCount : 0

  const outcome = applyVictoryCredits(
    { victoryProgress: stored.victoryProgress, weeklyChestCount },
    victoryCreditsAmount,
  )

  return {
    balance: stored.balance + creditsAmount,
    victoryProgress: outcome.victoryProgress,
    weeklyChestCount: outcome.weeklyChestCount,
    weekIdentity: currentWeekIdentity,
    chestEarned: outcome.chestEarned,
  }
}
