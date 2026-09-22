import { assertValidStakeAmount } from '../../domain/value-objects/stake-amount'
import type { ClockPort } from '../ports/ClockPort'
import type { StakeOperationResult, StakeRepositoryPort } from '../ports/StakeRepositoryPort'

export interface ReserveStakeInput {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  readonly occurredAt: Date
}

/**
 * HU-23 (Task #434). Reserva una apuesta. Valida la FORMA del monto (entero
 * >= 1, D5); el techo real (el disponible) lo aplica el repositorio contra la
 * fila de la cuenta, que es lo unico que conoce el saldo.
 */
export class ReserveStake {
  constructor(
    private readonly stakes: StakeRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  // `async` a proposito, igual que `CreditBattleReward`: cualquier throw
  // sincrono (la validacion del monto) debe rechazar la promesa, no escapar.
  async execute(input: ReserveStakeInput): Promise<StakeOperationResult> {
    assertValidStakeAmount(input.amount)

    return this.stakes.reserve(
      {
        operationId: input.operationId,
        playerId: input.playerId,
        battleId: input.battleId,
        amount: input.amount,
        occurredAt: input.occurredAt,
      },
      this.clock.now(),
    )
  }
}

export const RESERVE_STAKE = Symbol('ReserveStake')
