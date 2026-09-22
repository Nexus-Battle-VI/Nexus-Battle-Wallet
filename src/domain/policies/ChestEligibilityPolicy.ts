/**
 * Progreso de cofre por creditos de victoria (HU-22, Management #69).
 *
 * Reglas ya aceptadas por el PO, sin margen de interpretacion:
 * - Solo los creditos de VICTORIA alimentan el progreso (la participacion no).
 * - Al llegar a 20 se entrega un cofre y el progreso vuelve a 0, SIN remanente
 *   (18+4 -> cofre -> 0/20, no 2/20).
 * - Maximo 2 cofres por semana.
 * - Al llegar a 2/2, el progreso se CONGELA en 0 hasta que cambie la semana:
 *   una nueva victoria esa misma semana no mueve el contador ni genera un
 *   tercer cofre.
 */

export const VICTORY_PROGRESS_THRESHOLD = 20
export const WEEKLY_CHEST_LIMIT = 2

export interface ChestProgressState {
  readonly victoryProgress: number
  readonly weeklyChestCount: number
}

export interface ChestProgressOutcome {
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly chestEarned: boolean
}

/**
 * Aplica creditos de victoria al progreso de la semana YA vigente (el
 * llamador resuelve antes el rollover semanal: si la semana cambio,
 * `weeklyChestCount` debe llegar aqui en 0).
 *
 * Funcion pura: sin reloj, sin persistencia, sin aleatoriedad. Un mismo
 * estado de entrada produce siempre el mismo resultado.
 */
export const applyVictoryCredits = (
  state: ChestProgressState,
  victoryCreditsAmount: number,
): ChestProgressOutcome => {
  if (state.weeklyChestCount >= WEEKLY_CHEST_LIMIT) {
    // Limite semanal alcanzado: el progreso queda congelado en 0 (decision
    // del PO, Management #69) y ninguna victoria adicional esta semana
    // genera un tercer cofre.
    return { victoryProgress: 0, weeklyChestCount: state.weeklyChestCount, chestEarned: false }
  }

  if (victoryCreditsAmount === 0) {
    return {
      victoryProgress: state.victoryProgress,
      weeklyChestCount: state.weeklyChestCount,
      chestEarned: false,
    }
  }

  const candidateProgress = state.victoryProgress + victoryCreditsAmount

  if (candidateProgress >= VICTORY_PROGRESS_THRESHOLD) {
    return {
      victoryProgress: 0,
      weeklyChestCount: state.weeklyChestCount + 1,
      chestEarned: true,
    }
  }

  return {
    victoryProgress: candidateProgress,
    weeklyChestCount: state.weeklyChestCount,
    chestEarned: false,
  }
}
