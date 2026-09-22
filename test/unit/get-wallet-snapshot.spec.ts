import { GetWalletSnapshot } from '../../src/application/use-cases/GetWalletSnapshot'
import { CreditBattleReward } from '../../src/application/use-cases/CreditBattleReward'
import { ReserveStake } from '../../src/application/use-cases/ReserveStake'
import { InMemoryStakeRepository } from '../../src/adapters/outbound/persistence/InMemoryStakeRepository'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { VICTORY_PROGRESS_THRESHOLD } from '../../src/domain/policies/ChestEligibilityPolicy'
import type { ClockPort } from '../../src/application/ports/ClockPort'

class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
}

const AT = new Date('2026-09-22T15:00:00.000Z')

describe('GetWalletSnapshot', () => {
  it('un jugador sin movimientos tiene el estado inicial, no un error', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new GetWalletSnapshot(wallet, new FixedClock(AT))

    const snapshot = await useCase.execute('jugador-nuevo')

    expect(snapshot).toEqual({
      balance: 0,
      reserved: 0,
      available: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weeklyChestLimit: 2,
      weekIdentity: '2026-09-21',
      threshold: VICTORY_PROGRESS_THRESHOLD,
    })
  })

  it('refleja el estado tras un credito', async () => {
    const wallet = new InMemoryWalletRepository()
    const clock = new FixedClock(AT)
    await new CreditBattleReward(wallet, clock).execute({
      operationId: 'op-1',
      playerId: 'sub-1',
      battleId: 'b1',
      reason: 'BATTLE_REWARD',
      creditsAmount: 2,
      victoryCreditsAmount: 2,
      occurredAt: AT,
    })

    const snapshot = await new GetWalletSnapshot(wallet, clock).execute('sub-1')

    expect(snapshot).toMatchObject({ balance: 2, reserved: 0, available: 2, victoryProgress: 2 })
  })

  it('una reserva activa descuenta `available` sin tocar `balance` (S-18)', async () => {
    const store = new InMemoryWalletStore()
    store.accounts.set('sub-1', {
      balance: 100,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
    const wallet = new InMemoryWalletRepository(store)
    const clock = new FixedClock(AT)

    await new ReserveStake(new InMemoryStakeRepository(store), clock).execute({
      operationId: 'battle:b1:player:sub-1:stake:reserve',
      playerId: 'sub-1',
      battleId: 'b1',
      amount: 30,
      occurredAt: AT,
    })

    const snapshot = await new GetWalletSnapshot(wallet, clock).execute('sub-1')

    expect(snapshot).toMatchObject({ balance: 100, reserved: 30, available: 70 })
  })
})
