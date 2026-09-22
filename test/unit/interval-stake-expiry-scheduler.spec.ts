import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ExpireStakes } from '../../src/application/use-cases/ExpireStakes'
import { ReserveStake } from '../../src/application/use-cases/ReserveStake'
import { InMemoryStakeRepository } from '../../src/adapters/outbound/persistence/InMemoryStakeRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { createLogger } from '../../src/infrastructure/observability/logger'
import { StakeExpiryScheduler } from '../../src/infrastructure/scheduling/stake-expiry.scheduler'

class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
  set(instant: Date): void {
    this.instant = instant
  }
}

const AT = new Date('2026-09-22T15:00:00.000Z')
const PAST_DUE = new Date('2026-09-23T16:00:00.000Z')

const setup = async () => {
  const store = new InMemoryWalletStore()
  store.accounts.set('sub-1', {
    balance: 100,
    reserved: 0,
    victoryProgress: 0,
    weeklyChestCount: 0,
    weekIdentity: '2026-09-21',
  })

  const stakes = new InMemoryStakeRepository(store)
  const clock = new FixedClock(AT)
  const reserve = new ReserveStake(stakes, clock)
  const expire = new ExpireStakes(stakes, clock)

  await reserve.execute({
    operationId: 'battle:room-1:player:sub-1:stake:reserve',
    playerId: 'sub-1',
    battleId: 'room-1',
    amount: 10,
    occurredAt: AT,
  })

  return { store, stakes, clock, expire }
}

const capturedLines: string[] = []
const logger = createLogger({
  level: 'info',
  service: 'wallet-test',
  version: '0.0.0',
  sink: (line) => capturedLines.push(line),
})

describe('ExpireStakes y StakeExpiryScheduler (D11)', () => {
  beforeEach(() => {
    capturedLines.length = 0
  })

  it('un hold vencido se libera en el siguiente tick; uno vigente no se toca', async () => {
    const { store, clock, expire } = await setup()

    // Vigente todavia: no se toca.
    expect(await expire.execute()).toBe(0)
    expect(store.stakeHolds.get('battle:room-1:player:sub-1:stake:reserve')?.status).toBe('ACTIVE')

    clock.set(PAST_DUE)
    expect(await expire.execute()).toBe(1)

    const hold = store.stakeHolds.get('battle:room-1:player:sub-1:stake:reserve')
    expect(hold?.status).toBe('EXPIRED')
    expect(store.accounts.get('sub-1')?.reserved).toBe(0)
    expect(store.accounts.get('sub-1')?.balance).toBe(100)

    const ledger = store.stakeLedger.get('battle:room-1:player:sub-1:stake:reserve:expire')
    expect(ledger?.[0]).toMatchObject({ kind: 'EXPIRE', amount: 10, resultingReserved: 0 })

    // Segundo barrido: ya no hay nada que reclamar (no se libera dos veces).
    expect(await expire.execute()).toBe(0)
  })

  it('respeta el limite del lote por tick', async () => {
    const { store, clock } = await setup()
    const stakes = new InMemoryStakeRepository(store)

    await new ReserveStake(stakes, clock).execute({
      operationId: 'battle:room-2:player:sub-1:stake:reserve',
      playerId: 'sub-1',
      battleId: 'room-2',
      amount: 5,
      occurredAt: AT,
    })

    clock.set(PAST_DUE)

    expect(await stakes.expireStale(PAST_DUE, 1)).toBe(1)
    expect(await stakes.expireStale(PAST_DUE, 1)).toBe(1)
    expect(await stakes.expireStale(PAST_DUE, 1)).toBe(0)
  })

  it('el scheduler apagado (intervalo 0) no programa nada y lo registra', () => {
    const execute = jest.fn()
    const scheduler = new StakeExpiryScheduler({ execute } as unknown as ExpireStakes, 0, logger)

    scheduler.onApplicationBootstrap()
    scheduler.onModuleDestroy()

    expect(execute).not.toHaveBeenCalled()
    expect(capturedLines.join('\n')).toContain('stake_expiry_disabled')
  })

  it('el scheduler arranca por intervalo y se detiene con el ciclo de vida', async () => {
    jest.useFakeTimers()

    try {
      const execute = jest.fn().mockResolvedValue(0)
      const scheduler = new StakeExpiryScheduler(
        { execute } as unknown as ExpireStakes,
        1000,
        logger,
      )

      scheduler.onApplicationBootstrap()
      await jest.advanceTimersByTimeAsync(3000)
      expect(execute).toHaveBeenCalledTimes(3)

      scheduler.onModuleDestroy()
      await jest.advanceTimersByTimeAsync(3000)
      expect(execute).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })

  it('un fallo del barrido no lanza: se registra y se reintenta al siguiente tick', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('postgres caido'))
    const scheduler = new StakeExpiryScheduler({ execute } as unknown as ExpireStakes, 1000, logger)

    await expect(scheduler.tick()).resolves.toBe(0)
    expect(capturedLines.join('\n')).toContain('stake_expiry_failed')
  })

  it('un tick con trabajo registra cuantos holds se liberaron', async () => {
    const execute = jest.fn().mockResolvedValue(3)
    const scheduler = new StakeExpiryScheduler({ execute } as unknown as ExpireStakes, 1000, logger)

    await expect(scheduler.tick()).resolves.toBe(3)
    expect(capturedLines.join('\n')).toContain('stake_holds_expired')
  })
})
