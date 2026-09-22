import {
  assertValidStakeAmount,
  assertValidStakeCreditAmount,
} from '../../domain/value-objects/stake-amount'
import { SettlementNotZeroSumError } from '../errors/StakePersistenceError'
import type {
  SettleStakesCommand,
  SettleStakesResult,
  StakeRepositoryPort,
  StakeSettlementEntry,
} from '../ports/StakeRepositoryPort'

export type SettleStakesInput = SettleStakesCommand

/**
 * Validacion de forma de una liquidacion, ANTES de tocar la base (§5.3).
 *
 * La invariante es la suma cero: lo capturado a los perdedores debe ser
 * EXACTAMENTE lo acreditado a los ganadores. Una lista vacia no tiene sentido
 * (no hay nada que liquidar) y una lista de solo capturas la rompe (no hay
 * contrapartida): para liberar sin ganador se usa `/release`, no `/settle`.
 *
 * Un `CREDITED` con `amount: 0` SI es valido: es el ganador que aposto en una
 * batalla donde ningun perdedor aposto (el pozo es 0 y solo recupera su hold).
 */
export const assertValidSettlements = (settlements: readonly StakeSettlementEntry[]): void => {
  if (settlements.length === 0) {
    throw new SettlementNotZeroSumError('la lista de liquidaciones esta vacia.')
  }

  let capturedTotal = 0
  let creditedTotal = 0

  for (const settlement of settlements) {
    if (settlement.outcome === 'CAPTURED') {
      assertValidStakeAmount(settlement.amount)
      capturedTotal += settlement.amount
    } else {
      assertValidStakeCreditAmount(settlement.amount)
      creditedTotal += settlement.amount
    }
  }

  if (capturedTotal !== creditedTotal) {
    throw new SettlementNotZeroSumError(
      `se capturan ${String(capturedTotal)} y se acreditan ${String(creditedTotal)}.`,
    )
  }
}

/** HU-23 (Task #434). Liquida una batalla con ganador en UNA sola llamada (D10). */
export class SettleStakes {
  constructor(private readonly stakes: StakeRepositoryPort) {}

  async execute(input: SettleStakesInput): Promise<SettleStakesResult> {
    assertValidSettlements(input.settlements)

    return this.stakes.settle({
      operationId: input.operationId,
      battleId: input.battleId,
      settlements: input.settlements,
    })
  }
}

export const SETTLE_STAKES = Symbol('SettleStakes')
