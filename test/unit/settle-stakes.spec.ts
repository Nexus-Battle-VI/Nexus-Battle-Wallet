import {
  HoldAmountMismatchError,
  HoldNotFoundError,
  SettlementNotZeroSumError,
} from '../../src/application/errors/StakePersistenceError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ReserveStake } from '../../src/application/use-cases/ReserveStake'
import { SettleStakes } from '../../src/application/use-cases/SettleStakes'
import { InMemoryStakeRepository } from '../../src/adapters/outbound/persistence/InMemoryStakeRepository'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'

class FixedClock implements ClockPort {
  now(): Date {
    return AT
  }
}

const AT = new Date('2026-09-22T15:00:00.000Z')

const setup = (balances: Readonly<Record<string, number>>) => {
  const store = new InMemoryWalletStore()
  for (const [playerId, balance] of Object.entries(balances)) {
    store.accounts.set(playerId, {
      balance,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
  }

  const stakes = new InMemoryStakeRepository(store)
  const wallet = new InMemoryWalletRepository(store)
  const reserve = new ReserveStake(stakes, new FixedClock())
  const settle = new SettleStakes(stakes)

  return { store, stakes, wallet, reserve, settle }
}

const reserve = (
  reserveUseCase: ReserveStake,
  playerId: string,
  amount: number,
  battleId = 'room-1',
) =>
  reserveUseCase.execute({
    operationId: `battle:${battleId}:player:${playerId}:stake:reserve`,
    playerId,
    battleId,
    amount,
    occurredAt: AT,
  })

const holdIdOf = (playerId: string, battleId = 'room-1') =>
  `battle:${battleId}:player:${playerId}:stake:reserve`

const settleInput = (settlements: Parameters<SettleStakes['execute']>[0]['settlements']) => ({
  operationId: 'battle:room-1:stakes:settle',
  battleId: 'room-1',
  settlements,
})

describe('SettleStakes', () => {
  it('1v1 con ganador: el perdedor baja y el ganador sube EXACTAMENTE lo mismo (S-07)', async () => {
    const {
      store,
      wallet,
      reserve: reserveStake,
      settle,
    } = setup({
      'sub-1': 100,
      'sub-2': 100,
    })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10)

    const result = await settle.execute(
      settleInput([
        { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 10 },
      ]),
    )

    expect(result.applied).toBe(true)
    expect(result.results).toEqual([
      { playerId: 'sub-1', holdId: holdIdOf('sub-1'), balance: 90, reserved: 0, available: 90 },
      { playerId: 'sub-2', holdId: holdIdOf('sub-2'), balance: 110, reserved: 0, available: 110 },
    ])
    expect(store.stakeHolds.get(holdIdOf('sub-1'))?.status).toBe('CAPTURED')
    expect(store.stakeHolds.get(holdIdOf('sub-2'))?.status).toBe('RELEASED')
    await expect(wallet.getSnapshot('sub-1', '2026-09-21')).resolves.toMatchObject({
      balance: 90,
      reserved: 0,
    })
    await expect(wallet.getSnapshot('sub-2', '2026-09-21')).resolves.toMatchObject({
      balance: 110,
      reserved: 0,
    })
  })

  it('2v2: el pozo se reparte en partes iguales entre los ganadores con apuesta (S-08)', async () => {
    const { reserve: reserveStake, settle } = setup({
      'sub-1': 100,
      'sub-2': 100,
      'sub-3': 100,
      'sub-4': 100,
    })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 20)
    await reserve(reserveStake, 'sub-3', 5)
    await reserve(reserveStake, 'sub-4', 5)

    // Pozo = 30, repartido 15/15 (D2): no importa cuanto puso cada ganador.
    const result = await settle.execute(
      settleInput([
        { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CAPTURED', amount: 20 },
        { playerId: 'sub-3', holdId: holdIdOf('sub-3'), outcome: 'CREDITED', amount: 15 },
        { playerId: 'sub-4', holdId: holdIdOf('sub-4'), outcome: 'CREDITED', amount: 15 },
      ]),
    )

    expect(result.applied).toBe(true)
    expect(result.results).toEqual([
      { playerId: 'sub-1', holdId: holdIdOf('sub-1'), balance: 90, reserved: 0, available: 90 },
      { playerId: 'sub-2', holdId: holdIdOf('sub-2'), balance: 80, reserved: 0, available: 80 },
      { playerId: 'sub-3', holdId: holdIdOf('sub-3'), balance: 115, reserved: 0, available: 115 },
      { playerId: 'sub-4', holdId: holdIdOf('sub-4'), balance: 115, reserved: 0, available: 115 },
    ])
  })

  it('un CREDITED de 0 es valido: el ganador solo recupera su hold (nadie del equipo perdedor aposto)', async () => {
    const { wallet, reserve: reserveStake, settle } = setup({ 'sub-2': 100 })

    await reserve(reserveStake, 'sub-2', 10)

    const result = await settle.execute(
      settleInput([
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 0 },
      ]),
    )

    expect(result.applied).toBe(true)
    await expect(wallet.getSnapshot('sub-2', '2026-09-21')).resolves.toMatchObject({
      balance: 100,
      reserved: 0,
      available: 100,
    })
  })

  it.each([
    ['suma que no cuadra', 10, 8],
    ['solo capturas', 10, 0],
  ])(
    'rechaza una liquidacion con %s y NO aplica nada (S-15)',
    async (_caso, captured, credited) => {
      const {
        store,
        wallet,
        reserve: reserveStake,
        settle,
      } = setup({
        'sub-1': 100,
        'sub-2': 100,
      })

      await reserve(reserveStake, 'sub-1', 10)
      await reserve(reserveStake, 'sub-2', 10)

      await expect(
        settle.execute(
          settleInput([
            { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: captured },
            { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: credited },
          ]),
        ),
      ).rejects.toThrow(SettlementNotZeroSumError)

      expect(store.stakeHolds.get(holdIdOf('sub-1'))?.status).toBe('ACTIVE')
      expect(store.stakeHolds.get(holdIdOf('sub-2'))?.status).toBe('ACTIVE')
      await expect(wallet.getSnapshot('sub-1', '2026-09-21')).resolves.toMatchObject({
        balance: 100,
        reserved: 10,
      })
    },
  )

  it('rechaza una lista vacia como error de forma', async () => {
    const { settle } = setup({})

    await expect(settle.execute(settleInput([]))).rejects.toThrow(SettlementNotZeroSumError)
  })

  it('un CAPTURED que no coincide con el monto original del hold no aplica NADA (HOLD_AMOUNT_MISMATCH)', async () => {
    const {
      store,
      wallet,
      reserve: reserveStake,
      settle,
    } = setup({
      'sub-1': 100,
      'sub-2': 100,
    })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10)

    await expect(
      settle.execute(
        settleInput([
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 11 },
          { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 11 },
        ]),
      ),
    ).rejects.toThrow(HoldAmountMismatchError)

    expect(store.stakeHolds.get(holdIdOf('sub-1'))?.status).toBe('ACTIVE')
    await expect(wallet.getSnapshot('sub-1', '2026-09-21')).resolves.toMatchObject({
      balance: 100,
      reserved: 10,
    })
  })

  it('rechaza un hold de otra batalla, de otro jugador o ya cerrado (HOLD_NOT_FOUND)', async () => {
    const { reserve: reserveStake, settle } = setup({ 'sub-1': 100, 'sub-2': 100 })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10, 'room-2')

    // hold de sub-2 pertenece a room-2, no a esta liquidacion de room-1
    await expect(
      settle.execute(
        settleInput([
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
          {
            playerId: 'sub-2',
            holdId: holdIdOf('sub-2', 'room-2'),
            outcome: 'CREDITED',
            amount: 10,
          },
        ]),
      ),
    ).rejects.toThrow(HoldNotFoundError)

    // hold ajeno declarado por otro jugador
    await expect(
      settle.execute(
        settleInput([
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
          {
            playerId: 'sub-1',
            holdId: holdIdOf('sub-2', 'room-2'),
            outcome: 'CREDITED',
            amount: 10,
          },
        ]),
      ),
    ).rejects.toThrow(HoldNotFoundError)
  })

  it('rechaza el MISMO hold dos veces en la misma liquidacion', async () => {
    const { reserve: reserveStake, settle } = setup({ 'sub-1': 100 })

    await reserve(reserveStake, 'sub-1', 10)

    await expect(
      settle.execute(
        settleInput([
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CREDITED', amount: 10 },
        ]),
      ),
    ).rejects.toThrow(HoldNotFoundError)
  })

  it('reintentar la MISMA liquidacion es un replay con el mismo resultado (S-12)', async () => {
    const { reserve: reserveStake, settle } = setup({ 'sub-1': 100, 'sub-2': 100 })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10)

    const input = settleInput([
      { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
      { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 10 },
    ])

    const first = await settle.execute(input)
    const replay = await settle.execute(input)

    expect(replay).toEqual({ ...first, applied: false })
  })

  it('el replay compara por CONJUNTO: el mismo cuerpo en otro orden es el mismo replay', async () => {
    const { reserve: reserveStake, settle } = setup({ 'sub-1': 100, 'sub-2': 100 })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10)

    const first = await settle.execute(
      settleInput([
        { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 10 },
      ]),
    )

    const replay = await settle.execute(
      settleInput([
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 10 },
        { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
      ]),
    )

    expect(replay.applied).toBe(false)
    expect(replay.results).toEqual(first.results)
  })

  it('el MISMO operationId con OTRA liquidacion es conflicto, nada se reaplica (S-13)', async () => {
    const { store, reserve: reserveStake, settle } = setup({ 'sub-1': 100, 'sub-2': 100 })

    await reserve(reserveStake, 'sub-1', 10)
    await reserve(reserveStake, 'sub-2', 10)

    await settle.execute(
      settleInput([
        { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CAPTURED', amount: 10 },
        { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CREDITED', amount: 10 },
      ]),
    )

    await expect(
      settle.execute(
        settleInput([
          { playerId: 'sub-2', holdId: holdIdOf('sub-2'), outcome: 'CAPTURED', amount: 10 },
          { playerId: 'sub-1', holdId: holdIdOf('sub-1'), outcome: 'CREDITED', amount: 10 },
        ]),
      ),
    ).rejects.toThrow(OperationConflictError)

    expect(store.stakeHolds.get(holdIdOf('sub-1'))?.status).toBe('CAPTURED')
  })
})
