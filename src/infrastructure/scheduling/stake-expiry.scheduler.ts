import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common'

import type { ExpireStakes } from '../../application/use-cases/ExpireStakes'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Barrido periodico de holds vencidos (HU-23, WP-W7, D11).
 *
 * Sigue el patron de `IntervalRewardWorkflowScheduler` de Combat (HU-22):
 * intervalo dentro del proceso, sin coordinacion entre replicas -- la
 * reclamacion es durable en la base (el `FOR UPDATE` + relectura de estado de
 * `expireStale`), asi que dos instancias que barran a la vez no liberan dos
 * veces el mismo hold.
 *
 * `STAKE_EXPIRY_INTERVAL_MS=0` lo apaga (pruebas); en operacion normal nunca
 * deberia tener trabajo: una batalla dura minutos y sus holds se liberan o
 * liquidan al terminar.
 */
export class StakeExpiryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly expireStakes: ExpireStakes,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.info('stake_expiry_disabled', {
        detail: 'STAKE_EXPIRY_INTERVAL_MS=0: no hay barrido de reservas vencidas.',
      })

      return
    }

    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)

    // Un temporizador de fondo no debe impedir que el proceso termine.
    this.timer.unref()
  }

  onModuleDestroy(): void {
    this.stop()
  }

  /** Un ciclo del barrido. Nunca lanza: un fallo se registra y se reintenta al siguiente. */
  async tick(): Promise<number> {
    try {
      const expired = await this.expireStakes.execute()

      if (expired > 0) {
        this.logger.info('stake_holds_expired', { expired })
      }

      return expired
    } catch (error: unknown) {
      this.logger.warn('stake_expiry_failed', { detail: describeError(error) })

      return 0
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
