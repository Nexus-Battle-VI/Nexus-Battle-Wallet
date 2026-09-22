/**
 * Contrato interno Combat -> Wallet de apuestas (`hu-23-battle-stake-v1.md` §5).
 *
 * Los tres comandos llevan `operationId` determinista (el de reserva es tambien
 * el `holdId`). El repositorio es el unico que conoce el saldo real: por eso el
 * maximo de una reserva no se valida en el caso de uso, sino contra la fila de
 * la cuenta dentro de la transaccion.
 */

export interface ReserveStakeCommand {
  /** `battle:{battleId}:player:{playerId}:stake:reserve`, sin hashear. */
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  readonly occurredAt: Date
}

export type StakeReleaseReason = 'ROOM_CANCELLED' | 'PARTICIPANT_LEFT' | 'NO_WINNER'

export interface ReleaseStakeCommand {
  /** `battle:{battleId}:player:{playerId}:stake:release`, sin hashear. */
  readonly operationId: string
  /** El `operationId` de la reserva a liberar. */
  readonly holdId: string
  readonly reason: StakeReleaseReason
}

export type StakeSettlementOutcome = 'CAPTURED' | 'CREDITED'

export interface StakeSettlementEntry {
  readonly playerId: string
  readonly holdId: string
  readonly outcome: StakeSettlementOutcome
  readonly amount: number
}

export interface SettleStakesCommand {
  /** `battle:{battleId}:stakes:settle`: UNO por batalla, no por jugador (D10). */
  readonly operationId: string
  readonly battleId: string
  readonly settlements: readonly StakeSettlementEntry[]
}

/** Respuesta de `reserve`/`release`: el estado de la cuenta tras aplicarlo. */
export interface StakeOperationResult {
  readonly operationId: string
  /** `false` cuando la respuesta es el replay de una operacion ya aplicada. */
  readonly applied: boolean
  readonly holdId: string
  readonly balance: number
  readonly reserved: number
  readonly available: number
}

export interface StakeSettlementResult {
  readonly playerId: string
  readonly holdId: string
  readonly balance: number
  readonly reserved: number
  readonly available: number
}

/** Respuesta de `settle`: el estado final de cada cuenta tocada. */
export interface SettleStakesResult {
  readonly operationId: string
  readonly applied: boolean
  readonly results: readonly StakeSettlementResult[]
}

export const STAKE_REPOSITORY = Symbol('StakeRepositoryPort')

export interface StakeRepositoryPort {
  /**
   * Reserva sincrona (D8). Nunca toca `balance`: solo `reserved`. Si el
   * disponible no alcanza, lanza `InsufficientAvailableBalanceError` y no
   * escribe nada.
   *
   * `clockNow` lo aporta el caso de uso (ClockPort): `created_at` y
   * `expires_at = clockNow + 24 h` (D11) salen del reloj del servicio, no de
   * `occurredAt` (que es informativo, del emisor).
   */
  reserve(command: ReserveStakeCommand, clockNow: Date): Promise<StakeOperationResult>

  /**
   * Libera un hold `ACTIVE` (cancelacion, `leave` pre-inicio o `NO_WINNER`).
   * Idempotente respecto al `operationId` y tambien respecto al estado del
   * hold: liberar algo ya cerrado no falla ni vuelve a tocar `reserved`.
   */
  release(command: ReleaseStakeCommand): Promise<StakeOperationResult>

  /**
   * Liquida una batalla con ganador en UNA transaccion: exige suma cero entre
   * `CAPTURED` y `CREDITED` (verificado antes de tocar la base y de nuevo
   * contra el propio registro de holds), adquiere los locks de jugador en
   * orden determinista y valida cada hold contra su monto original.
   */
  settle(command: SettleStakesCommand): Promise<SettleStakesResult>

  /**
   * Red de seguridad de D11: libera hasta `limit` holds `ACTIVE` vencidos.
   * Devuelve cuantos se liberaron de verdad. Nunca lanza por un hold que otra
   * instancia ya expiro: lo salta.
   */
  expireStale(clockNow: Date, limit: number): Promise<number>
}
