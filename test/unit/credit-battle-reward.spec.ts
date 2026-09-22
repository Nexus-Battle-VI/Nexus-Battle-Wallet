import { CreditBattleReward } from '../../src/application/use-cases/CreditBattleReward'
import { GetWalletSnapshot } from '../../src/application/use-cases/GetWalletSnapshot'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { DomainError } from '../../src/domain/errors/DomainError'
import type { ClockPort } from '../../src/application/ports/ClockPort'

class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
  set(instant: Date): void {
    this.instant = instant
  }
}

// Martes 2026-09-22, semana America/Bogota del lunes 2026-09-21.
const MID_WEEK = new Date('2026-09-22T15:00:00.000Z')
// Lunes 2026-09-28, semana siguiente.
const NEXT_WEEK = new Date('2026-09-28T15:00:00.000Z')

const input = (overrides: Partial<Parameters<CreditBattleReward['execute']>[0]> = {}) => ({
  operationId: 'battle:room-1:player:sub-1:credit',
  playerId: 'sub-1',
  battleId: 'room-1',
  reason: 'BATTLE_REWARD',
  creditsAmount: 2,
  victoryCreditsAmount: 2,
  occurredAt: MID_WEEK,
  ...overrides,
})

describe('CreditBattleReward', () => {
  it('acredita el saldo y el progreso de victoria de un ganador 1v1', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new CreditBattleReward(wallet, new FixedClock(MID_WEEK))

    const result = await useCase.execute(input())

    expect(result).toMatchObject({
      applied: true,
      balance: 2,
      victoryProgress: 2,
      chestEarned: false,
    })
  })

  it('la participacion (victoryCreditsAmount=0) suma saldo pero no progreso', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new CreditBattleReward(wallet, new FixedClock(MID_WEEK))

    const result = await useCase.execute(
      input({
        creditsAmount: 1,
        victoryCreditsAmount: 0,
        operationId: 'battle:room-1:player:sub-2:credit',
        playerId: 'sub-2',
      }),
    )

    expect(result).toMatchObject({ balance: 1, victoryProgress: 0, chestEarned: false })
  })

  it('reintentar el MISMO operationId con el MISMO cuerpo devuelve el mismo resultado (applied=false)', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new CreditBattleReward(wallet, new FixedClock(MID_WEEK))

    const first = await useCase.execute(input())
    const replay = await useCase.execute(input())

    expect(replay).toEqual({ ...first, applied: false })
  })

  it('reintentar el MISMO operationId con OTRO cuerpo es un conflicto, nunca se reaplica', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new CreditBattleReward(wallet, new FixedClock(MID_WEEK))

    await useCase.execute(input())

    await expect(
      useCase.execute(input({ creditsAmount: 4, victoryCreditsAmount: 4 })),
    ).rejects.toThrow(OperationConflictError)

    const snapshot = await new GetWalletSnapshot(wallet, new FixedClock(MID_WEEK)).execute('sub-1')
    expect(snapshot.balance).toBe(2)
  })

  it('rechaza un monto fuera del catalogo cerrado sin tocar el saldo', async () => {
    const wallet = new InMemoryWalletRepository()
    const useCase = new CreditBattleReward(wallet, new FixedClock(MID_WEEK))

    await expect(
      useCase.execute(input({ creditsAmount: 3, victoryCreditsAmount: 0 })),
    ).rejects.toThrow(DomainError)

    const snapshot = await new GetWalletSnapshot(wallet, new FixedClock(MID_WEEK)).execute('sub-1')
    expect(snapshot.balance).toBe(0)
  })

  it('un retry del mismo operationId nunca cambia chestEarned (evidencia estable, S3 del contrato)', async () => {
    const wallet = new InMemoryWalletRepository()
    const clock = new FixedClock(MID_WEEK)
    const useCase = new CreditBattleReward(wallet, clock)
    const win = (operationId: string, battleId: string) =>
      useCase.execute(
        input({
          operationId,
          playerId: 'sub-3',
          creditsAmount: 4,
          victoryCreditsAmount: 4,
          battleId,
        }),
      )

    await win('op-pre-1', 'b0') // 4/20
    await win('op-pre-2', 'b0b') // 8/20
    await win('op-pre-3', 'b0c') // 12/20
    await win('op-pre-4', 'b0d') // 16/20
    const chest = await win('op-b', 'b2') // 20/20 -> cofre
    expect(chest.chestEarned).toBe(true)

    const replay = await win('op-b', 'b2')
    expect(replay.chestEarned).toBe(true)
    expect(replay.applied).toBe(false)
  })

  it('al llegar a 2/2 cofres, una nueva victoria esa semana no genera un tercero', async () => {
    const wallet = new InMemoryWalletRepository()
    const clock = new FixedClock(MID_WEEK)
    const useCase = new CreditBattleReward(wallet, clock)
    const player = 'sub-4'
    let battle = 0

    const win4 = () =>
      useCase.execute(
        input({
          operationId: `op-${String((battle += 1))}`,
          playerId: player,
          battleId: `battle-${String(battle)}`,
          creditsAmount: 4,
          victoryCreditsAmount: 4,
        }),
      )

    await win4() // 4/20
    await win4() // 8/20
    await win4() // 12/20
    await win4() // 16/20
    const first = await win4() // 20 -> cofre 1/2, progreso 0
    expect(first).toMatchObject({ chestEarned: true, weeklyChestCount: 1, victoryProgress: 0 })

    await win4() // 4/20
    await win4() // 8/20
    await win4() // 12/20
    await win4() // 16/20
    const second = await win4() // 20 -> cofre 2/2
    expect(second).toMatchObject({ chestEarned: true, weeklyChestCount: 2, victoryProgress: 0 })

    const third = await win4() // deberia quedar congelado
    expect(third).toMatchObject({ chestEarned: false, weeklyChestCount: 2, victoryProgress: 0 })
  })

  it('el rollover semanal reinicia el contador de cofres pero no revive uno perdido', async () => {
    const wallet = new InMemoryWalletRepository()
    const clock = new FixedClock(MID_WEEK)
    const useCase = new CreditBattleReward(wallet, clock)
    const player = 'sub-5'

    for (let i = 0; i < 5; i += 1) {
      await useCase.execute(
        input({
          operationId: `week1-op-${String(i)}`,
          playerId: player,
          battleId: `week1-battle-${String(i)}`,
          creditsAmount: 4,
          victoryCreditsAmount: 4,
        }),
      )
    }
    for (let i = 0; i < 5; i += 1) {
      await useCase.execute(
        input({
          operationId: `week1-op-b${String(i)}`,
          playerId: player,
          battleId: `week1-battle-b${String(i)}`,
          creditsAmount: 4,
          victoryCreditsAmount: 4,
        }),
      )
    }

    const before = await new GetWalletSnapshot(wallet, clock).execute(player)
    expect(before.weeklyChestCount).toBe(2)

    clock.set(NEXT_WEEK)
    const afterRollover = await new GetWalletSnapshot(wallet, clock).execute(player)
    expect(afterRollover.weeklyChestCount).toBe(0)

    const thirdChestNewWeek = await useCase.execute(
      input({
        operationId: 'week2-op-1',
        playerId: player,
        battleId: 'week2-battle-1',
        creditsAmount: 4,
        victoryCreditsAmount: 4,
        occurredAt: NEXT_WEEK,
      }),
    )
    expect(thirdChestNewWeek.weeklyChestCount).toBe(0) // 4/20, todavia no cofre
  })
})
