import type {
  ReleaseStakeCommand,
  StakeOperationResult,
  StakeRepositoryPort,
} from '../ports/StakeRepositoryPort'

export type ReleaseStakeInput = ReleaseStakeCommand

/**
 * HU-23 (Task #434). Libera un hold `ACTIVE`. No decide nada: la idempotencia
 * (por `operationId` y por estado del hold) vive en el repositorio.
 */
export class ReleaseStake {
  constructor(private readonly stakes: StakeRepositoryPort) {}

  async execute(input: ReleaseStakeInput): Promise<StakeOperationResult> {
    return this.stakes.release({
      operationId: input.operationId,
      holdId: input.holdId,
      reason: input.reason,
    })
  }
}

export const RELEASE_STAKE = Symbol('ReleaseStake')
