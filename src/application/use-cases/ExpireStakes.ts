import type { ClockPort } from '../ports/ClockPort'
import type { StakeRepositoryPort } from '../ports/StakeRepositoryPort'

/** Tamano del lote del barrido: acota el trabajo por tick. */
export const STAKE_EXPIRY_BATCH_LIMIT = 100

/**
 * HU-23 (Task #434, WP-W7). Red de seguridad de D11: un hold `ACTIVE` que
 * vencio (24 h) se libera solo. Nunca deberia dispararse en operacion normal
 * (una batalla dura minutos); existe por si Combat muere sin liberar ni
 * liquidar. Es una liberacion, no una captura: el jugador recupera su
 * disponible.
 */
export class ExpireStakes {
  constructor(
    private readonly stakes: StakeRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<number> {
    return this.stakes.expireStale(this.clock.now(), STAKE_EXPIRY_BATCH_LIMIT)
  }
}

export const EXPIRE_STAKES = Symbol('ExpireStakes')
