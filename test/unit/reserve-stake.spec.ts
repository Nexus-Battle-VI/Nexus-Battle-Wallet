import { InsufficientAvailableBalanceError } from '../../src/application/errors/StakePersistenceError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ReserveStake } from '../../src/application/use-cases/ReserveStake'
import { InMemoryStakeRepository } from '../../src/adapters/outbound/persistence/InMemoryStakeRepository'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { InvalidStakeAmountError } from '../../src/domain/value-objects/stake-amount'

class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
}

const AT = new Date('2026-09-22T15:00:00.000Z')
const TTL_MS = 24 * 60 * 60 * 1000

const setup = (balance: number) => {
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

  return { store, stakes, wallet, useCase: new ReserveStake(stakes, new FixedClock(AT)) }
}

const input = (overrides: Partial<Parameters<ReserveStake['execute']>[0]> = {}) => ({
  operationId: 'battle:room-1:player:sub-1:stake:reserve',
  playerId: 'sub-1',
  battleId: 'room-1',
  amount: 10,
  occurredAt: AT,
  ...overrides,
})

describe('ReserveStake', () => {
  it('reserva el monto: `reserved` sube y `balance` NO se toca (S-01, S-18)', async () => {
    const { store, wallet, useCase } = setup(100)

    const result = await useCase.execute(input())

    expect(result).toEqual({
      operationId: 'battle:room-1:player:sub-1:stake:reserve',
      applied: true,
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      balance: 100,
      reserved: 10,
      available: 90,
    })

    const snapshot = await wallet.getSnapshot('sub-1', '2026-09-21')
    expect(snapshot).toMatchObject({ balance: 100, reserved: 10, available: 90 })

    const hold = store.stakeHolds.get('battle:room-1:player:sub-1:stake:reserve')
    expect(hold).toMatchObject({ amount: 10, status: 'ACTIVE' })
    expect(hold?.expiresAt.getTime()).toBe(AT.getTime() + TTL_MS)
  })

  it('rechaza si el disponible no alcanza y NO escribe nada (S-03)', async () => {
    const { store, wallet, useCase } = setup(5)

    await expect(useCase.execute(input({ amount: 10 }))).rejects.toThrow(
      InsufficientAvailableBalanceError,
    )

    expect(store.stakeHolds.size).toBe(0)
    expect(store.stakeLedger.size).toBe(0)
    const snapshot = await wallet.getSnapshot('sub-1', '2026-09-21')
    expect(snapshot).toMatchObject({ balance: 5, reserved: 0, available: 5 })
  })

  it('el disponible descuenta reservas anteriores, no solo el balance', async () => {
    const { useCase } = setup(30)

    await useCase.execute(input({ amount: 20 }))

    await expect(
      useCase.execute(
        input({
          operationId: 'battle:room-2:player:sub-1:stake:reserve',
          battleId: 'room-2',
          amount: 11,
        }),
      ),
    ).rejects.toThrow(InsufficientAvailableBalanceError)
  })

  it('reintentar el MISMO operationId con el MISMO cuerpo es un replay (S-12)', async () => {
    const { useCase } = setup(100)

    const first = await useCase.execute(input())
    const replay = await useCase.execute(input())

    expect(replay).toEqual({ ...first, applied: false })
  })

  it('el replay devuelve el resultado ORIGINAL aunque despues hayan movido la cuenta', async () => {
    const { stakes, useCase } = setup(100)

    const first = await useCase.execute(input())
    await stakes.release({
      operationId: 'battle:room-1:player:sub-1:stake:release',
      holdId: 'battle:room-1:player:sub-1:stake:reserve',
      reason: 'ROOM_CANCELLED',
    })

    const replay = await useCase.execute(input())

    // El ledger es insert-only: el reintento relee el resultado de la reserva,
    // no el estado actual (que ya tiene `reserved` en 0).
    expect(replay).toEqual({ ...first, applied: false })
  })

  it('el MISMO operationId con OTRO monto es conflicto, nunca otra reserva (S-13)', async () => {
    const { store, useCase } = setup(100)

    await useCase.execute(input())

    await expect(useCase.execute(input({ amount: 20 }))).rejects.toThrow(OperationConflictError)
    expect(store.stakeHolds.size).toBe(1)
  })

  it('el MISMO operationId con OTRA batalla o jugador es conflicto', async () => {
    const { useCase } = setup(100)

    await useCase.execute(input())

    await expect(useCase.execute(input({ battleId: 'room-2' }))).rejects.toThrow(
      OperationConflictError,
    )
    await expect(useCase.execute(input({ playerId: 'sub-2' }))).rejects.toThrow(
      OperationConflictError,
    )
  })

  it.each([[0], [-3], [1.5]])(
    'rechaza el monto invalido %s sin tocar la cuenta (INVALID_AMOUNT)',
    async (amount) => {
      const { store, useCase } = setup(100)

      await expect(useCase.execute(input({ amount }))).rejects.toThrow(InvalidStakeAmountError)
      expect(store.stakeHolds.size).toBe(0)
    },
  )

  it('un jugador sin fila de cuenta y sin saldo recibe disponible insuficiente, no un error tecnico', async () => {
    const store = new InMemoryWalletStore()
    const useCase = new ReserveStake(new InMemoryStakeRepository(store), new FixedClock(AT))

    await expect(useCase.execute(input({ playerId: 'jugador-nuevo' }))).rejects.toThrow(
      InsufficientAvailableBalanceError,
    )
  })
})
