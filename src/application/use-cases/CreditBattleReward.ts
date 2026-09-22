import { assertValidBattleRewardAmounts } from '../../domain/value-objects/battle-reward-amounts'
import { weekIdentityOf } from '../../domain/value-objects/week-identity'
import type { ClockPort } from '../ports/ClockPort'
import type { CreditBattleRewardResult, WalletRepositoryPort } from '../ports/WalletRepositoryPort'

export interface CreditBattleRewardInput {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly reason: string
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly occurredAt: Date
}

/**
 * Task HU-22.2. Acredita el derecho de creditos que HU-21 ya calculo
 * (`BattleCreditsPolicy`, Combat) y decide si corresponde cofre.
 *
 * Este caso de uso NO decide si toca cofre por si mismo: delega en el
 * repositorio, que aplica `ChestEligibilityPolicy` dentro de la misma
 * transaccion que acredita el saldo (S3 del contrato: no hay una segunda
 * escritura que pueda desincronizarse de la primera).
 */
export class CreditBattleReward {
  constructor(
    private readonly wallet: WalletRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  // `async` a proposito: aunque el cuerpo no tiene otro `await`, garantiza que
  // CUALQUIER throw sincrono (la validacion del catalogo cerrado, por
  // ejemplo) se convierta en una promesa rechazada, no en una excepcion que
  // escapa antes de que exista una promesa que capturarla.
  async execute(input: CreditBattleRewardInput): Promise<CreditBattleRewardResult> {
    assertValidBattleRewardAmounts(input.creditsAmount, input.victoryCreditsAmount)

    const currentWeekIdentity = weekIdentityOf(this.clock.now())

    return this.wallet.creditBattleReward(
      {
        operationId: input.operationId,
        playerId: input.playerId,
        battleId: input.battleId,
        reason: input.reason,
        creditsAmount: input.creditsAmount,
        victoryCreditsAmount: input.victoryCreditsAmount,
        occurredAt: input.occurredAt,
      },
      currentWeekIdentity,
    )
  }
}

export const CREDIT_BATTLE_REWARD = Symbol('CreditBattleReward')
