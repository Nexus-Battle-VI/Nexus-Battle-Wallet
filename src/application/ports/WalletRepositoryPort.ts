export interface CreditBattleRewardCommand {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly reason: string
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly occurredAt: Date
}

export interface WalletStateSnapshot {
  readonly balance: number
  readonly victoryProgress: number
  readonly weeklyChestCount: number
  readonly weeklyChestLimit: number
  readonly weekIdentity: string
}

/**
 * Lectura ampliada de HU-23 §6: `reserved` es la suma de los holds `ACTIVE`
 * (persistida) y `available = balance - reserved` (derivada, no persistida).
 * Es lo unico contra lo que se valida una reserva nueva.
 */
export interface WalletSnapshot extends WalletStateSnapshot {
  readonly reserved: number
  readonly available: number
}

export interface CreditBattleRewardResult extends WalletStateSnapshot {
  readonly operationId: string
  /** `false` cuando la respuesta es el replay de una operacion ya aplicada. */
  readonly applied: boolean
  readonly chestEarned: boolean
}

export const WALLET_REPOSITORY = Symbol('WalletRepositoryPort')

/**
 * Unica fuente de verdad del saldo, el progreso de victoria y el contador
 * semanal de cofres (ADR-019, HU-22). Wallet calcula su propio estado; nunca
 * recibe un balance o progreso ya calculado por quien llama.
 */
export interface WalletRepositoryPort {
  /**
   * Aplica un credito de HU-22 de forma idempotente por `operationId`.
   *
   * `currentWeekIdentity` la calcula el caso de uso con `ClockPort` (America/
   * Bogota, HU-22 S1); el repositorio no conoce la zona horaria, solo compara
   * identidades de semana ya resueltas.
   */
  creditBattleReward(
    command: CreditBattleRewardCommand,
    currentWeekIdentity: string,
  ): Promise<CreditBattleRewardResult>

  /** Lectura para `GET /api/v1/wallet/me`. Aplica el mismo rollover perezoso. */
  getSnapshot(playerId: string, currentWeekIdentity: string): Promise<WalletSnapshot>
}
