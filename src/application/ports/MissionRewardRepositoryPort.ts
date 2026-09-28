/**
 * Credito de mision (HU-10, Task HU-10.3; `hu-10-mission-completion-reward-v1` §9).
 *
 * Es una operacion PROPIA de Wallet, distinta de `creditBattleReward` (HU-22):
 * una mision no es una victoria JcJ, asi que esta operacion incrementa SOLO el
 * saldo y NO toca `victory_progress`, `weekly_chest_count` ni `week_identity`
 * de una cuenta existente, ni evalua cofre.
 */

/** Dificultad ejecutada (HU-75). Wallet valida la forma; no decide nada con ella. */
export const MISSION_REWARD_DIFFICULTIES = ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'] as const

export type MissionRewardDifficulty = (typeof MISSION_REWARD_DIFFICULTIES)[number]

export interface CreditMissionRewardCommand {
  /** `mission:{enrollmentId}:reward:{rewardKey}`. Congelado por Missions; identico en cada reintento. */
  readonly operationId: string
  /** Beneficiario: el jugador de la matricula. */
  readonly playerId: string
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: MissionRewardDifficulty
  /** `{group}:{key}` de la linea de recompensa (contrato §12). */
  readonly rewardKey: string
  /** Entero `>= 1`, ya congelado por Missions. Wallet no lo calcula. */
  readonly creditsAmount: number
  /** `settledAt` congelado de la liquidacion. NUNCA se sustituye por la hora de Wallet. */
  readonly occurredAt: Date
  /**
   * Semana con la que NACE una cuenta que todavia no existe (`week_identity` es
   * `NOT NULL`). No se compara ni se usa con una cuenta existente: la operacion no
   * hace rollover semanal.
   */
  readonly initialWeekIdentity: string
}

export interface CreditMissionRewardResult {
  readonly operationId: string
  /** `false` en el replay de una operacion ya aplicada. */
  readonly applied: boolean
  /** Saldo tras la aplicacion original (el mismo en un replay). */
  readonly balance: number
}

export const MISSION_REWARD_REPOSITORY = Symbol('MissionRewardRepositoryPort')

export interface MissionRewardRepositoryPort {
  /**
   * Acredita un credito de mision, una sola vez por `operationId`.
   *
   * Mismo `operationId` y mismo contenido: devuelve el resultado original con
   * `applied: false`, sin tocar el saldo. Mismo `operationId` con otro contenido:
   * `OperationConflictError` (`409`), sin sobrescribir nada. Saldo y asiento del
   * ledger cambian juntos, en una sola transaccion.
   */
  creditMissionReward(command: CreditMissionRewardCommand): Promise<CreditMissionRewardResult>
}
