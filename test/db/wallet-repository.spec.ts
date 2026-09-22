import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresWalletRepository } from '../../src/adapters/outbound/persistence/PostgresWalletRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * PostgreSQL REAL (Testcontainers, HU-22 S43 del prompt: "no declarar
 * integracion unicamente con repository memory"). Lo que se prueba aqui no
 * se puede probar con `InMemoryWalletRepository`: los CHECK constraints, el
 * indice UNIQUE de `operation_id` y, sobre todo, que dos operaciones
 * CONCURRENTES sobre el mismo jugador no rompan el umbral de 20 ni el
 * limite de 2 cofres/semana (`pg_advisory_xact_lock`).
 */
describe('PostgresWalletRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresWalletRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    repository = new PostgresWalletRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const WEEK1 = '2026-09-21'
  const WEEK2 = '2026-09-28'

  it('acredita saldo y progreso de victoria de un ganador 1v1', async () => {
    const result = await repository.creditBattleReward(
      {
        operationId: 'op-pg-1',
        playerId: 'player-pg-1',
        battleId: 'battle-pg-1',
        reason: 'BATTLE_REWARD',
        creditsAmount: 2,
        victoryCreditsAmount: 2,
        occurredAt: new Date('2026-09-22T15:00:00.000Z'),
      },
      WEEK1,
    )

    expect(result).toMatchObject({
      applied: true,
      balance: 2,
      victoryProgress: 2,
      weeklyChestCount: 0,
      chestEarned: false,
    })
  })

  it('un retry del mismo operationId con el mismo cuerpo no duplica el saldo (constraint UNIQUE real)', async () => {
    const command = {
      operationId: 'op-pg-retry',
      playerId: 'player-pg-2',
      battleId: 'battle-pg-2',
      reason: 'BATTLE_REWARD',
      creditsAmount: 1,
      victoryCreditsAmount: 0,
      occurredAt: new Date('2026-09-22T15:00:00.000Z'),
    }

    const first = await repository.creditBattleReward(command, WEEK1)
    const retry = await repository.creditBattleReward(command, WEEK1)

    expect(first.applied).toBe(true)
    expect(retry.applied).toBe(false)
    expect(retry.balance).toBe(1)
  })

  it('el mismo operationId con otro cuerpo lanza OperationConflictError, sin tocar el saldo', async () => {
    const base = {
      operationId: 'op-pg-conflict',
      playerId: 'player-pg-3',
      battleId: 'battle-pg-3',
      reason: 'BATTLE_REWARD',
      creditsAmount: 2,
      victoryCreditsAmount: 2,
      occurredAt: new Date('2026-09-22T15:00:00.000Z'),
    }

    await repository.creditBattleReward(base, WEEK1)

    await expect(
      repository.creditBattleReward({ ...base, creditsAmount: 4, victoryCreditsAmount: 4 }, WEEK1),
    ).rejects.toThrow(OperationConflictError)

    const snapshot = await repository.getSnapshot('player-pg-3', WEEK1)
    expect(snapshot.balance).toBe(2)
  })

  it('el mismo operationId con otro reason u occurredAt tambien lanza OperationConflictError (no solo los montos)', async () => {
    const base = {
      operationId: 'op-pg-conflict-intent',
      playerId: 'player-pg-conflict-intent',
      battleId: 'battle-pg-conflict-intent',
      reason: 'BATTLE_REWARD',
      creditsAmount: 2,
      victoryCreditsAmount: 2,
      occurredAt: new Date('2026-09-22T15:00:00.000Z'),
    }

    await repository.creditBattleReward(base, WEEK1)

    // `occurred_at` vuelve de Postgres como `Date`: si la comparacion fuera
    // por identidad de objeto (no por valor), esto pasaria como replay por
    // error incluso con exactamente el mismo cuerpo.
    const sameBodyReplay = await repository.creditBattleReward({ ...base }, WEEK1)
    expect(sameBodyReplay.applied).toBe(false)

    await expect(
      repository.creditBattleReward({ ...base, reason: 'OTRA_COSA' }, WEEK1),
    ).rejects.toThrow(OperationConflictError)

    await expect(
      repository.creditBattleReward(
        { ...base, occurredAt: new Date('2026-09-22T18:00:00.000Z') },
        WEEK1,
      ),
    ).rejects.toThrow(OperationConflictError)

    const snapshot = await repository.getSnapshot('player-pg-conflict-intent', WEEK1)
    expect(snapshot.balance).toBe(2)
  })

  it('20 creditos de victoria entregan un cofre y reinician el progreso sin remanente', async () => {
    const player = 'player-pg-4'
    let battle = 0
    const win4 = () =>
      repository.creditBattleReward(
        {
          operationId: `op-pg-win-${String((battle += 1))}`,
          playerId: player,
          battleId: `battle-pg-win-${String(battle)}`,
          reason: 'BATTLE_REWARD',
          creditsAmount: 4,
          victoryCreditsAmount: 4,
          occurredAt: new Date('2026-09-22T15:00:00.000Z'),
        },
        WEEK1,
      )

    await win4()
    await win4()
    await win4()
    await win4()
    const fifth = await win4()

    expect(fifth).toMatchObject({ chestEarned: true, victoryProgress: 0, weeklyChestCount: 1 })
  })

  it('dos creditos CONCURRENTES del mismo jugador no producen dos cofres cuando solo corresponde uno', async () => {
    const player = 'player-pg-concurrent'

    // Progreso inicial 16/20 con una operacion previa.
    await repository.creditBattleReward(
      {
        operationId: 'op-pg-concurrent-seed',
        playerId: player,
        battleId: 'battle-seed',
        reason: 'BATTLE_REWARD',
        creditsAmount: 4,
        victoryCreditsAmount: 4,
        occurredAt: new Date('2026-09-22T15:00:00.000Z'),
      },
      WEEK1,
    )
    // 4/20 tras la semilla; se necesitan 3 más de +4 (16 total) para dejarlo
    // en 16/20 antes de la carrera.
    for (let i = 0; i < 3; i += 1) {
      await repository.creditBattleReward(
        {
          operationId: `op-pg-concurrent-pre-${String(i)}`,
          playerId: player,
          battleId: `battle-pre-${String(i)}`,
          reason: 'BATTLE_REWARD',
          creditsAmount: 4,
          victoryCreditsAmount: 4,
          occurredAt: new Date('2026-09-22T15:00:00.000Z'),
        },
        WEEK1,
      )
    }

    const before = await repository.getSnapshot(player, WEEK1)
    expect(before.victoryProgress).toBe(16)

    // Dos batallas del MISMO jugador terminan casi a la vez, cada una con
    // +4: solo UNA puede cruzar el umbral. Sin el advisory lock por jugador,
    // ambas leerian 16/20 y ambas producirian "cofre".
    const [first, second] = await Promise.all([
      repository.creditBattleReward(
        {
          operationId: 'op-pg-concurrent-a',
          playerId: player,
          battleId: 'battle-concurrent-a',
          reason: 'BATTLE_REWARD',
          creditsAmount: 4,
          victoryCreditsAmount: 4,
          occurredAt: new Date('2026-09-22T15:00:00.000Z'),
        },
        WEEK1,
      ),
      repository.creditBattleReward(
        {
          operationId: 'op-pg-concurrent-b',
          playerId: player,
          battleId: 'battle-concurrent-b',
          reason: 'BATTLE_REWARD',
          creditsAmount: 4,
          victoryCreditsAmount: 4,
          occurredAt: new Date('2026-09-22T15:00:00.000Z'),
        },
        WEEK1,
      ),
    ])

    const chestsEarned = [first.chestEarned, second.chestEarned].filter(Boolean).length
    expect(chestsEarned).toBe(1)

    const after = await repository.getSnapshot(player, WEEK1)
    // 16 + 4 + 4 = 24: cruza el umbral una sola vez, el resto (4, sin
    // remanente del cofre) sigue acumulando hacia el siguiente.
    expect(after.victoryProgress).toBe(4)
    expect(after.weeklyChestCount).toBe(1)
  })

  it('el rollover semanal reinicia el contador de cofres al leer una semana nueva', async () => {
    const player = 'player-pg-rollover'

    await repository.creditBattleReward(
      {
        operationId: 'op-pg-rollover-1',
        playerId: player,
        battleId: 'battle-rollover-1',
        reason: 'BATTLE_REWARD',
        creditsAmount: 4,
        victoryCreditsAmount: 4,
        occurredAt: new Date('2026-09-22T15:00:00.000Z'),
      },
      WEEK1,
    )

    const stillWeek1 = await repository.getSnapshot(player, WEEK1)
    expect(stillWeek1.victoryProgress).toBe(4)

    const rolledOver = await repository.getSnapshot(player, WEEK2)
    // El progreso de victoria NO es semanal (solo el contador de cofres lo
    // es): sigue en 4 aunque la semana identificada sea otra.
    expect(rolledOver).toMatchObject({
      victoryProgress: 4,
      weeklyChestCount: 0,
      weekIdentity: WEEK2,
    })
  })

  it('un jugador desconocido devuelve el estado inicial, no un error', async () => {
    const snapshot = await repository.getSnapshot('player-pg-inexistente', WEEK1)

    expect(snapshot).toEqual({
      balance: 0,
      reserved: 0,
      available: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weeklyChestLimit: 2,
      weekIdentity: WEEK1,
    })
  })
})
