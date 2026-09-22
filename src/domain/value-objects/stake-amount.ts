import { DomainError } from '../errors/DomainError'

/**
 * Monto de una apuesta (contrato `hu-23-battle-stake-v1.md`, D5): entero >= 1.
 *
 * Aqui NO hay maximo propio: el unico techo es el saldo DISPONIBLE del jugador,
 * que solo se conoce contra la fila de su cuenta (no es una validacion de
 * forma, es de negocio, y la aplica el repositorio dentro de la transaccion).
 */
export class InvalidStakeAmountError extends DomainError {
  constructor(amount: number) {
    super(`El monto de la apuesta debe ser un entero >= 1: ${String(amount)}`)
    this.name = 'InvalidStakeAmountError'
  }
}

export const assertValidStakeAmount = (amount: number): void => {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new InvalidStakeAmountError(amount)
  }
}

/**
 * Parte del pozo acreditada a un ganador. Puede ser 0 de forma legitima: si
 * ningun integrante del equipo perdedor aposto, el pozo es 0 y el ganador solo
 * recupera su propio hold (el `amount` de un `CREDITED` es la parte ajena, no
 * lo que se libera de `reserved`).
 */
export const assertValidStakeCreditAmount = (amount: number): void => {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new InvalidStakeAmountError(amount)
  }
}
