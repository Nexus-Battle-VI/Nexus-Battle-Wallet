/**
 * Estado de una reserva de apuesta (contrato `hu-23-battle-stake-v1.md` §4.1).
 *
 * Son cuatro estados, no seis: el contrato manda sobre el plan. Un hold que
 * sirvio para acreditar una victoria queda `RELEASED` (su monto vuelve a
 * `available`) y lo que lo distingue de una liberacion normal es la entrada
 * `SETTLE_CREDIT` del ledger, no un estado propio.
 */
export const STAKE_HOLD_STATUSES = ['ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'] as const

export type StakeHoldStatus = (typeof STAKE_HOLD_STATUSES)[number]

export interface StakeHold {
  /** Igual al `operationId` de la reserva: no hay un id separado. */
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  readonly status: StakeHoldStatus
  readonly createdAt: Date
  /** `createdAt + 24 h` (D11). Red de seguridad, no operacion normal. */
  readonly expiresAt: Date
}
