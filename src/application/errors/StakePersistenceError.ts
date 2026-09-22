/**
 * Errores del contrato interno de apuestas (`hu-23-battle-stake-v1.md` §11).
 * El adaptador de entrada los traduce a 422 con su `code`; ninguno de ellos es
 * un fallo transitorio, asi que nunca se reintentan tal cual.
 */

/** El monto pedido supera el disponible del jugador (Wallet, en `reserve`). */
export class InsufficientAvailableBalanceError extends Error {
  readonly code = 'INSUFFICIENT_AVAILABLE_BALANCE'

  constructor(playerId: string, available: number, amount: number) {
    super(
      `El jugador ${playerId} tiene ${String(available)} disponible y pidio reservar ${String(amount)}.`,
    )
    this.name = 'InsufficientAvailableBalanceError'
  }
}

/** El `holdId` no existe, o no esta `ACTIVE` para la operacion pedida. */
export class HoldNotFoundError extends Error {
  readonly code = 'HOLD_NOT_FOUND'

  constructor(holdId: string) {
    super(`No hay una reserva activa con el holdId ${holdId}.`)
    this.name = 'HoldNotFoundError'
  }
}

/**
 * La suma de los `CAPTURED` no coincide con la de los `CREDITED` de la misma
 * liquidacion: es el control barato de CA-07 (no duplicar ni perder creditos).
 * Nada se aplica.
 */
export class SettlementNotZeroSumError extends Error {
  readonly code = 'SETTLEMENT_NOT_ZERO_SUM'

  constructor(detail: string) {
    super(`La liquidacion no es de suma cero: ${detail}`)
    this.name = 'SettlementNotZeroSumError'
  }
}

/** Un `CAPTURED` no coincide con el monto original de su hold. */
export class HoldAmountMismatchError extends Error {
  readonly code = 'HOLD_AMOUNT_MISMATCH'

  constructor(holdId: string, holdAmount: number, requestedAmount: number) {
    super(
      `El hold ${holdId} se reservo por ${String(holdAmount)} y se intento capturar por ${String(requestedAmount)}.`,
    )
    this.name = 'HoldAmountMismatchError'
  }
}
