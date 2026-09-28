import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresMissionRewardRepository } from '../../src/adapters/outbound/persistence/PostgresMissionRewardRepository'
import { PostgresWalletRepository } from '../../src/adapters/outbound/persistence/PostgresWalletRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { CreditMissionRewardCommand } from '../../src/application/ports/MissionRewardRepositoryPort'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * Creditos de mision contra PostgreSQL REAL (HU-10, Task HU-10.3;
 * `hu-10-mission-completion-reward-v1` §9).
 *
 * Lo que un doble no puede demostrar:
 *   - la migracion `006`: tabla, restricciones, unicidad y trigger insert-only;
 *   - que saldo y asiento cambien en UNA transaccion (rollback si algo falla);
 *   - que `operation_id` unico y los advisory locks resistan reintentos y
 *     concurrencia;
 *   - que el saldo persista y que HU-22 (progreso de victoria, cofres, semana) no
 *     se toque.
 */
describe('PostgresMissionRewardRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let rewards: PostgresMissionRewardRepository

  const SETTLED_AT = new Date('2026-10-02T03:00:05.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error) throw new Error('La migracion fallo.')
    rewards = new PostgresMissionRewardRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  let sequence = 0
  const nextPlayer = (): string => `sub-mision-${String((sequence += 1))}`

  const commandOf = (
    playerId: string,
    overrides: Partial<CreditMissionRewardCommand> = {},
  ): CreditMissionRewardCommand => {
    const enrollmentId = overrides.enrollmentId ?? `enr-${playerId}`
    const rewardKey = overrides.rewardKey ?? 'guaranteed:credits'

    return {
      operationId: `mission:${enrollmentId}:reward:${rewardKey}`,
      playerId,
      enrollmentId,
      missionId: 'msn_templo_olvidado',
      difficulty: 'NORMAL',
      rewardKey,
      creditsAmount: 50,
      occurredAt: SETTLED_AT,
      initialWeekIdentity: '2026-09-28',
      ...overrides,
    }
  }

  const account = async (playerId: string) =>
    (
      await sql<{
        balance: string
        reserved: string
        victory_progress: number
        weekly_chest_count: number
        week_identity: string
      }>`select balance, reserved, victory_progress, weekly_chest_count, week_identity
         from wallet_accounts where player_id = ${playerId}`.execute(db)
    ).rows[0]

  const ledgerRows = async (playerId: string) =>
    (
      await sql<{ operation_id: string; credits_amount: string; resulting_balance: string }>`
        select operation_id, credits_amount, resulting_balance
        from wallet_mission_reward_credits where player_id = ${playerId} order by created_at`.execute(
        db,
      )
    ).rows

  const seedAccount = async (
    playerId: string,
    values: {
      balance: number
      victoryProgress: number
      weeklyChestCount: number
      weekIdentity: string
      reserved?: number
    },
  ): Promise<void> => {
    await sql`insert into wallet_accounts
      (player_id, balance, reserved, victory_progress, weekly_chest_count, week_identity)
      values (${playerId}, ${values.balance}, ${values.reserved ?? 0}, ${values.victoryProgress},
              ${values.weeklyChestCount}, ${values.weekIdentity})`.execute(db)
  }

  describe('migracion 006', () => {
    it('crea la tabla propia, con restricciones, unicidad e indice', async () => {
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'wallet_mission_reward_credits'`.execute(db)
      const names = columns.rows.map((row) => row.column_name).sort()

      expect(names).toEqual(
        [
          'operation_id',
          'player_id',
          'reason',
          'enrollment_id',
          'mission_id',
          'difficulty',
          'reward_key',
          'credits_amount',
          'occurred_at',
          'resulting_balance',
          'created_at',
        ].sort(),
      )
      // Nada de semantica de batalla en este ledger.
      for (const forbidden of ['battle_id', 'victory_credits_amount', 'chest_earned']) {
        expect(names).not.toContain(forbidden)
      }

      const constraints = await sql<{ conname: string }>`
        select conname from pg_constraint
        where conrelid = 'wallet_mission_reward_credits'::regclass`.execute(db)

      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          'wallet_mission_reward_credits_pkey',
          'wallet_mission_reward_credits_amount_positive',
          'wallet_mission_reward_credits_reason',
          'wallet_mission_reward_credits_difficulty',
          'wallet_mission_reward_credits_line_unique',
        ]),
      )
    })

    it('no toca wallet_ledger: los asientos de HU-22 siguen igual', async () => {
      const battle = new PostgresWalletRepository(db)
      const player = nextPlayer()
      await battle.creditBattleReward(
        {
          operationId: `battle:room-1:player:${player}:credit`,
          playerId: player,
          battleId: 'room-1',
          reason: 'BATTLE_REWARD',
          creditsAmount: 2,
          victoryCreditsAmount: 2,
          occurredAt: new Date('2026-09-29T15:00:00.000Z'),
        },
        '2026-09-28',
      )
      const before = await sql`select * from wallet_ledger where player_id = ${player}`.execute(db)

      await rewards.creditMissionReward(commandOf(player))

      const after = await sql`select * from wallet_ledger where player_id = ${player}`.execute(db)

      expect(after.rows).toEqual(before.rows)
      expect(after.rows).toHaveLength(1)
    })
  })

  describe('aplicacion y persistencia', () => {
    it('primera aplicacion: cuenta nueva, saldo y asiento juntos', async () => {
      const player = nextPlayer()

      const result = await rewards.creditMissionReward(commandOf(player))

      expect(result).toEqual({
        operationId: `mission:enr-${player}:reward:guaranteed:credits`,
        applied: true,
        balance: 50,
      })
      expect(await account(player)).toMatchObject({
        balance: '50',
        reserved: '0',
        victory_progress: 0,
        weekly_chest_count: 0,
        week_identity: '2026-09-28',
      })
      expect(await ledgerRows(player)).toEqual([
        {
          operation_id: `mission:enr-${player}:reward:guaranteed:credits`,
          credits_amount: '50',
          resulting_balance: '50',
        },
      ])
    })

    it('el saldo persiste y acumula sobre el existente', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 100,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-28',
      })

      const result = await rewards.creditMissionReward(commandOf(player, { creditsAmount: 25 }))

      expect(result.balance).toBe(125)
      expect((await account(player))?.balance).toBe('125')
    })

    it('saldos grandes: bigint, sin perder precision en el rango seguro', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 9_000_000_000_000,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-28',
      })

      const result = await rewards.creditMissionReward(
        commandOf(player, { creditsAmount: 1_000_000_000_000 }),
      )

      expect(result.balance).toBe(10_000_000_000_000)
    })
  })

  describe('idempotencia', () => {
    it('replay: applied:false con el MISMO balance y sin sumar', async () => {
      const player = nextPlayer()
      const first = await rewards.creditMissionReward(commandOf(player))

      const replay = await rewards.creditMissionReward(commandOf(player))

      expect(replay).toEqual({ ...first, applied: false })
      expect((await account(player))?.balance).toBe('50')
      expect(await ledgerRows(player)).toHaveLength(1)
    })

    it('replay tras "reiniciar": instancia y conexion nuevas sobre la MISMA base', async () => {
      const player = nextPlayer()
      const first = await rewards.creditMissionReward(commandOf(player))

      const otherDb = createDatabase({ connectionString: container.getConnectionUri() })

      try {
        const restarted = new PostgresMissionRewardRepository(otherDb)

        expect(await restarted.creditMissionReward(commandOf(player))).toEqual({
          ...first,
          applied: false,
        })
      } finally {
        await otherDb.destroy()
      }

      expect((await account(player))?.balance).toBe('50')
    })

    it('el replay devuelve el balance del asiento ORIGINAL aunque el saldo cambie despues', async () => {
      const player = nextPlayer()
      await rewards.creditMissionReward(commandOf(player))
      await rewards.creditMissionReward(
        commandOf(player, { rewardKey: 'first-time:credits', creditsAmount: 10 }),
      )

      expect(await rewards.creditMissionReward(commandOf(player))).toMatchObject({
        applied: false,
        balance: 50,
      })
    })

    it.each([
      ['el importe', { creditsAmount: 51 }],
      ['el jugador', { playerId: 'otro-jugador' }],
      ['la mision', { missionId: 'msn_otra' }],
      ['la dificultad', { difficulty: 'HEROIC' as const }],
      ['el instante', { occurredAt: new Date('2026-10-02T03:00:06.000Z') }],
    ])('mismo operationId con otro %s: conflicto, sin sobrescribir', async (_label, changed) => {
      const player = nextPlayer()
      await rewards.creditMissionReward(commandOf(player))

      await expect(
        rewards.creditMissionReward({ ...commandOf(player), ...changed }),
      ).rejects.toThrow(OperationConflictError)

      expect((await account(player))?.balance).toBe('50')
      expect(await ledgerRows(player)).toHaveLength(1)
      expect(await account('otro-jugador')).toBeUndefined()
    })

    it('dos veces A LA VEZ el mismo credito: se acredita una sola', async () => {
      const player = nextPlayer()

      const [a, b] = await Promise.all([
        rewards.creditMissionReward(commandOf(player)),
        rewards.creditMissionReward(commandOf(player)),
      ])

      expect([a.applied, b.applied].sort()).toEqual([false, true])
      expect(a.balance).toBe(50)
      expect(b.balance).toBe(50)
      expect((await account(player))?.balance).toBe('50')
      expect(await ledgerRows(player)).toHaveLength(1)
    })

    it('creditos DISTINTOS del mismo jugador a la vez no pierden saldo', async () => {
      const player = nextPlayer()
      const keys = ['guaranteed:a', 'guaranteed:b', 'first-time:c', 'objective-bonus:d']

      await Promise.all(
        keys.map((rewardKey) =>
          rewards.creditMissionReward(commandOf(player, { rewardKey, creditsAmount: 10 })),
        ),
      )

      expect((await account(player))?.balance).toBe('40')
      expect(await ledgerRows(player)).toHaveLength(4)
    })
  })

  describe('atomicidad y rollback', () => {
    it('si el asiento no se puede insertar, el saldo NO cambia (una sola transaccion)', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 100,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-28',
      })
      // Una linea de la misma matricula YA acreditada con OTRO operation_id: el
      // asiento nuevo viola la unicidad `(enrollment_id, reward_key)` DESPUES de que
      // el saldo se haya actualizado dentro de la transaccion.
      await sql`insert into wallet_mission_reward_credits
        (operation_id, player_id, reason, enrollment_id, mission_id, difficulty, reward_key,
         credits_amount, occurred_at, resulting_balance)
        values ('otra-operacion', ${player}, 'MISSION_REWARD', ${`enr-${player}`}, 'm', 'NORMAL',
                'guaranteed:credits', 5, now(), 5)`.execute(db)

      await expect(rewards.creditMissionReward(commandOf(player))).rejects.toThrow()

      expect((await account(player))?.balance).toBe('100')
      expect(await ledgerRows(player)).toHaveLength(1)
    })

    it('un credito que desborda el rango seguro se rechaza y no cambia nada', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: Number.MAX_SAFE_INTEGER - 5,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-28',
      })

      await expect(
        rewards.creditMissionReward(commandOf(player, { creditsAmount: 10 })),
      ).rejects.toThrow()

      expect((await account(player))?.balance).toBe(String(Number.MAX_SAFE_INTEGER - 5))
      expect(await ledgerRows(player)).toHaveLength(0)
    })
  })

  describe('ledger insert-only y restricciones', () => {
    it('el motor rechaza UPDATE y DELETE sobre un asiento', async () => {
      const player = nextPlayer()
      await rewards.creditMissionReward(commandOf(player))

      await expect(
        sql`update wallet_mission_reward_credits set credits_amount = 999 where player_id = ${player}`.execute(
          db,
        ),
      ).rejects.toThrow(/insert-only/)
      await expect(
        sql`delete from wallet_mission_reward_credits where player_id = ${player}`.execute(db),
      ).rejects.toThrow(/insert-only/)

      expect((await ledgerRows(player))[0]?.credits_amount).toBe('50')
    })

    it('operation_id es unico y (matricula, linea) tambien', async () => {
      const player = nextPlayer()
      await rewards.creditMissionReward(commandOf(player))

      await expect(
        sql`insert into wallet_mission_reward_credits
          (operation_id, player_id, reason, enrollment_id, mission_id, difficulty, reward_key,
           credits_amount, occurred_at, resulting_balance)
          values (${`mission:enr-${player}:reward:guaranteed:credits`}, 'x', 'MISSION_REWARD', 'e2', 'm', 'NORMAL',
                  'guaranteed:otro', 1, now(), 1)`.execute(db),
      ).rejects.toThrow(/duplicate key|unique/i)
    })

    it.each([
      ['un importe menor que 1', 'credits_amount = 0', 0],
      ['un motivo que no es de mision', "reason = 'BATTLE_REWARD'", 1],
      ['una dificultad fuera del vocabulario', "difficulty = 'EASY'", 1],
    ])('el motor rechaza %s', async (_label, _column, amount) => {
      const reason = _column.startsWith('reason') ? 'BATTLE_REWARD' : 'MISSION_REWARD'
      const difficulty = _column.startsWith('difficulty') ? 'EASY' : 'NORMAL'

      await expect(
        sql`insert into wallet_mission_reward_credits
          (operation_id, player_id, reason, enrollment_id, mission_id, difficulty, reward_key,
           credits_amount, occurred_at, resulting_balance)
          values (${`op-${_label}`}, 'x', ${reason}, ${`e-${_label}`}, 'm', ${difficulty}, 'guaranteed:k',
                  ${amount}, now(), 5)`.execute(db),
      ).rejects.toThrow()
    })
  })

  describe('aislamiento de HU-22', () => {
    it('victoria 19, cofres 1, semana vieja: el credito de mision NO toca nada de eso', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 30,
        reserved: 10,
        victoryProgress: 19,
        weeklyChestCount: 1,
        weekIdentity: '2026-01-05',
      })

      const result = await rewards.creditMissionReward(commandOf(player, { creditsAmount: 50 }))

      expect(result.balance).toBe(80)
      expect(await account(player)).toMatchObject({
        balance: '80',
        reserved: '10',
        victory_progress: 19,
        weekly_chest_count: 1,
        week_identity: '2026-01-05',
      })
    })

    it('BORDE DE SEMANA: aunque la semana de "ahora" sea otra, la mision no hace rollover', async () => {
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 0,
        victoryProgress: 12,
        weeklyChestCount: 2,
        weekIdentity: '2026-09-21',
      })

      // `initialWeekIdentity` (la semana de "ahora") es DISTINTA de la de la cuenta.
      await rewards.creditMissionReward(commandOf(player, { initialWeekIdentity: '2026-10-05' }))

      expect(await account(player)).toMatchObject({
        victory_progress: 12,
        weekly_chest_count: 2,
        week_identity: '2026-09-21',
      })
    })

    it('HU-22 sigue igual tras una mision: la batalla que lleva a 20 SI da cofre', async () => {
      const battle = new PostgresWalletRepository(db)
      const player = nextPlayer()
      await seedAccount(player, {
        balance: 0,
        victoryProgress: 19,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-28',
      })
      await rewards.creditMissionReward(commandOf(player, { creditsAmount: 500 }))

      const reward = await battle.creditBattleReward(
        {
          operationId: `battle:room-9:player:${player}:credit`,
          playerId: player,
          battleId: 'room-9',
          reason: 'BATTLE_REWARD',
          creditsAmount: 2,
          victoryCreditsAmount: 2,
          occurredAt: new Date('2026-09-29T15:00:00.000Z'),
        },
        '2026-09-28',
      )

      expect(reward).toMatchObject({ chestEarned: true, balance: 502, weeklyChestCount: 1 })
    })
  })
})
