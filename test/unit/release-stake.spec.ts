import {
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
} from '../../src/application/errors/StakePersistenceError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ReleaseStake } from '../../src/application/use-cases/ReleaseStake'
import { ReserveStake } from '../../src/application/use-cases/ReserveStake'
import { InMemoryStakeRepository } from '../../src/adapters/outbound/persistence/InMemoryStakeRepository'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'

class FixedClock implements ClockPort {
  now(): Date {
    return AT
  }
}

const AT = new Date('2026-09-22T15:00:00.000Z')

const setup = async (balance = 100) => {
  const store = new InMemoryWalletStore()
  store.accounts.set('sub-1', {
    balance,
    reserved: 0,
    victoryProgress: 0,
    weeklyChestCount: 0,
    weekIdentity: '2026-09-21',
  })

  const stakes = new InMemoryStakeRepository(store)
  const wallet = new InMemoryWalletRepository(store)
  const clock = new FixedClock()
  const reserve = new ReserveStake(stakes, clock)
  const release = new ReleaseStake(stakes)

  await reserve.execute({
    operationId: 'battle:room-1:player:sub-1:stake:reserve',
    playerId: 'sub-1',
    battleId: 'room-1',
    amount: 10,
    occurredAt: AT,
  })

  return { store, stakes, wallet, release }
}

const input = (overrides: Partial<Parameters<ReleaseStake['execute']>[0]> = {}) => ({
  operationId: 'battle:room-1:player:sub-1:stake:release',
  holdId: 'battle:room-1:player:sub-1:stake:reserve',
  reason: 'ROOM_CANCELLED' as const,
  ...overrides,
})

describe('ReleaseStake', () => {
  it('libera el hold: `reserved` baja y `balance` NO se toca (S-05)', async () => {
    const { store, wallet, release } = await setup(100)

    const result = await release.execute(input())

    expect(result).toEqual({
      operationId: 'battle:room-1:player:sub-1:stake:release',
      applied: true,
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      balance: 100,
      reserved: 0,
      available: 100,
    })
    expect(store.stakeHolds.get('battle:room-1:player:sub-1:stake:reserve')?.status).toBe(
      'RELEASED',
    )
    await expect(wallet.getSnapshot('sub-1', '2026-09-21')).resolves.toMatchObject({
      balance: 100,
      reserved: 0,
      available: 100,
    })
  })

  it('reintentar la MISMA liberacion devuelve el mismo resultado (S-12)', async () => {
    const { release } = await setup()

    const first = await release.execute(input())
    const replay = await release.execute(input())

    expect(replay).toEqual({ ...first, applied: false })
  })

  it('liberar con OTRA operacion un hold ya liberado no vuelve a tocar `reserved`', async () => {
    const { store, release } = await setup()

    await release.execute(input())

    const second = await release.execute(
      input({ operationId: 'battle:room-1:player:sub-1:stake:release:2' }),
    )

    expect(second).toMatchObject({ applied: false, balance: 100, reserved: 0, available: 100 })
    const account = store.accounts.get('sub-1')
    expect(account?.reserved).toBe(0)
  })

  it('el MISMO operationId de liberacion con OTRO holdId es conflicto (S-13)', async () => {
    const { release } = await setup()

    await release.execute(input())

    await expect(release.execute(input({ holdId: 'otro-hold' }))).rejects.toThrow(
      OperationConflictError,
    )
  })

  it('un holdId inexistente responde HOLD_NOT_FOUND', async () => {
    const { release } = await setup()

    await expect(release.execute(input({ holdId: 'no-existe' }))).rejects.toThrow(HoldNotFoundError)
  })

  it('un hold capturado (perdido) no se puede liberar: queda como no-op, no como error', async () => {
    const store = new InMemoryWalletStore()
    for (const playerId of ['sub-1', 'sub-2']) {
      store.accounts.set(playerId, {
        balance: 100,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })
    }
    const stakes = new InMemoryStakeRepository(store)
    const clock = new FixedClock()

    for (const playerId of ['sub-1', 'sub-2']) {
      await new ReserveStake(stakes, clock).execute({
        operationId: `battle:room-1:player:${playerId}:stake:reserve`,
        playerId,
        battleId: 'room-1',
        amount: 10,
        occurredAt: AT,
      })
    }

    await stakes.settle({
      operationId: 'battle:room-1:stakes:settle',
      battleId: 'room-1',
      settlements: [
        {
          playerId: 'sub-1',
          holdId: 'battle:room-1:player:sub-1:stake:reserve',
          outcome: 'CAPTURED',
          amount: 10,
        },
        {
          playerId: 'sub-2',
          holdId: 'battle:room-1:player:sub-2:stake:reserve',
          outcome: 'CREDITED',
          amount: 10,
        },
      ],
    })

    const release = new ReleaseStake(stakes)
    const result = await release.execute({
      operationId: 'battle:room-1:player:sub-1:stake:release',
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      reason: 'ROOM_CANCELLED',
    })

    expect(result).toMatchObject({ applied: false, balance: 90, reserved: 0, available: 90 })
  })

  it('reservar de nuevo el mismo jugador tras liberar exige una operacion NUEVA (el id viejo es replay)', async () => {
    const { release, stakes } = await setup(100)

    await release.execute(input())

    await expect(
      stakes.reserve(
        {
          operationId: 'battle:room-1:player:sub-1:stake:reserve',
          playerId: 'sub-1',
          battleId: 'room-1',
          amount: 10,
          occurredAt: AT,
        },
        AT,
      ),
    ).resolves.toMatchObject({ applied: false })
  })

  it('un fallo de disponible no deja estado a medias', async () => {
    const store = new InMemoryWalletStore()
    store.accounts.set('sub-9', {
      balance: 1,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
    const stakes = new InMemoryStakeRepository(store)
    const reserve = new ReserveStake(stakes, new FixedClock())

    await expect(
      reserve.execute({
        operationId: 'battle:r:player:sub-9:stake:reserve',
        playerId: 'sub-9',
        battleId: 'r',
        amount: 2,
        occurredAt: AT,
      }),
    ).rejects.toThrow(InsufficientAvailableBalanceError)

    expect(store.accounts.get('sub-9')?.reserved).toBe(0)
    expect(store.stakeHolds.size).toBe(0)
  })
})
