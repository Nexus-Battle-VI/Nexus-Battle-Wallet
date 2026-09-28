import { InMemoryMissionRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryMissionRewardRepository'
import { InMemoryWalletRepository } from '../../src/adapters/outbound/persistence/InMemoryWalletRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import {
  InvalidMissionRewardAmountError,
  MissionRewardSchemaError,
} from '../../src/application/errors/MissionRewardError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { CreditBattleReward } from '../../src/application/use-cases/CreditBattleReward'
import {
  CreditMissionReward,
  type CreditMissionRewardInput,
} from '../../src/application/use-cases/CreditMissionReward'

/**
 * HU-10, Task HU-10.3: credito de mision (`hu-10-mission-completion-reward-v1` §9).
 *
 * Lo que se comprueba:
 *   - aplicacion, replay y conflicto por `operationId` (contenido completo, con
 *     `occurredAt`);
 *   - que Wallet valida la FORMA del importe y no decide cuanto vale una mision;
 *   - que la operacion NO toca el progreso de victoria, los cofres ni la semana
 *     (HU-22 sigue igual), incluso en el borde de cambio de semana.
 *
 * Los importes son valores de PRUEBA, no reglas de negocio.
 */
class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
  set(instant: Date): void {
    this.instant = instant
  }
}

// Martes 2026-09-22 (semana de Bogota del lunes 2026-09-21) y la semana siguiente.
const MID_WEEK = new Date('2026-09-22T15:00:00.000Z')
const NEXT_WEEK = new Date('2026-09-29T15:00:00.000Z')
const SETTLED_AT = '2026-10-02T03:00:05.000Z'
const ENROLLMENT = 'enr_01JB8Y3K7Q'

const input = (overrides: Partial<CreditMissionRewardInput> = {}): CreditMissionRewardInput => ({
  schemaVersion: 1,
  operationId: `mission:${ENROLLMENT}:reward:guaranteed:credits`,
  playerId: 'sub-1',
  reason: 'MISSION_REWARD',
  enrollmentId: ENROLLMENT,
  missionId: 'msn_templo_olvidado',
  difficulty: 'NORMAL',
  rewardKey: 'guaranteed:credits',
  creditsAmount: 50,
  occurredAt: SETTLED_AT,
  ...overrides,
})

const setup = (now: Date = MID_WEEK) => {
  const store = new InMemoryWalletStore()
  const clock = new FixedClock(now)

  return {
    store,
    clock,
    useCase: new CreditMissionReward(new InMemoryMissionRewardRepository(store), clock),
    battle: new CreditBattleReward(new InMemoryWalletRepository(store), clock),
  }
}

describe('CreditMissionReward', () => {
  describe('aplicacion y respuesta', () => {
    it('acredita el saldo y responde SOLO operationId, applied y balance', async () => {
      const { useCase } = setup()

      const result = await useCase.execute(input())

      expect(result).toEqual({
        operationId: `mission:${ENROLLMENT}:reward:guaranteed:credits`,
        applied: true,
        balance: 50,
      })
      for (const forbidden of [
        'victoryProgress',
        'weeklyChestCount',
        'weeklyChestLimit',
        'weekIdentity',
        'chestEarned',
      ]) {
        expect(result).not.toHaveProperty(forbidden)
      }
    })

    it('acumula sobre el saldo existente', async () => {
      const { useCase, store } = setup()
      store.accounts.set('sub-1', {
        balance: 100,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })

      expect((await useCase.execute(input())).balance).toBe(150)
    })

    it('crea la cuenta en cero cuando no existe, con la semana actual', async () => {
      const { useCase, store } = setup()

      await useCase.execute(input({ playerId: 'sub-nuevo' }))

      expect(store.accounts.get('sub-nuevo')).toEqual({
        balance: 50,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })
    })

    it('varias lineas de la misma matricula se acreditan por separado', async () => {
      const { useCase } = setup()

      await useCase.execute(input())
      const bonus = await useCase.execute(
        input({
          operationId: `mission:${ENROLLMENT}:reward:first-time:credits`,
          rewardKey: 'first-time:credits',
          creditsAmount: 10,
        }),
      )

      expect(bonus).toMatchObject({ applied: true, balance: 60 })
    })
  })

  describe('idempotencia', () => {
    it('replay: mismo operationId y mismo cuerpo -> applied:false, mismo balance, sin sumar', async () => {
      const { useCase, store } = setup()
      const first = await useCase.execute(input())

      const replay = await useCase.execute(input())

      expect(first.applied).toBe(true)
      expect(replay).toEqual({ ...first, applied: false })
      expect(store.accounts.get('sub-1')?.balance).toBe(50)
    })

    it('el replay devuelve el balance ORIGINAL aunque el saldo haya cambiado despues', async () => {
      const { useCase } = setup()
      await useCase.execute(input())
      await useCase.execute(
        input({
          operationId: `mission:${ENROLLMENT}:reward:first-time:credits`,
          rewardKey: 'first-time:credits',
          creditsAmount: 10,
        }),
      )

      expect(await useCase.execute(input())).toMatchObject({ applied: false, balance: 50 })
    })

    it('el instante se compara por VALOR: otro formato del mismo instante es un replay', async () => {
      const { useCase } = setup()
      await useCase.execute(input({ occurredAt: '2026-10-02T03:00:05.000Z' }))

      await expect(
        useCase.execute(input({ occurredAt: '2026-10-02T03:00:05Z' })),
      ).resolves.toMatchObject({ applied: false })
      await expect(
        useCase.execute(input({ occurredAt: '2026-10-01T22:00:05.000-05:00' })),
      ).resolves.toMatchObject({ applied: false })
    })

    it.each([
      ['el importe', { creditsAmount: 51 }],
      ['el jugador', { playerId: 'sub-otro' }],
      ['la mision', { missionId: 'msn_otra' }],
      ['la dificultad', { difficulty: 'HEROIC' }],
      ['el instante', { occurredAt: '2026-10-02T03:00:06.000Z' }],
    ])('mismo operationId con otro %s es conflicto y NO sobrescribe', async (_label, changed) => {
      const { useCase, store } = setup()
      await useCase.execute(input())

      await expect(useCase.execute(input(changed))).rejects.toThrow(OperationConflictError)

      expect(store.accounts.get('sub-1')?.balance).toBe(50)
      await expect(useCase.execute(input())).resolves.toMatchObject({ applied: false, balance: 50 })
    })
  })

  describe('validacion de la forma (Wallet no decide el importe)', () => {
    it.each([
      0,
      -1,
      -50,
      1.5,
      0.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])(
      'un importe que no es entero >= 1 dentro del rango seguro es 422: %s',
      async (creditsAmount) => {
        const { useCase, store } = setup()

        await expect(useCase.execute(input({ creditsAmount }))).rejects.toThrow(
          InvalidMissionRewardAmountError,
        )
        expect(store.accounts.size).toBe(0)
      },
    )

    it('cualquier entero positivo valido se acepta: no hay catalogo {1,2,4} ni tabla por dificultad', async () => {
      const { useCase } = setup()

      // 3, 7 y 50 no estan en el catalogo de batalla; y la misma cantidad vale igual
      // en todas las dificultades: Wallet no las distingue.
      for (const [index, difficulty] of ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'].entries()) {
        const rewardKey = `guaranteed:c${String(index)}`
        const result = await useCase.execute(
          input({
            operationId: `mission:${ENROLLMENT}:reward:${rewardKey}`,
            rewardKey,
            difficulty,
            creditsAmount: 7,
          }),
        )

        expect(result.applied).toBe(true)
      }
    })

    it('un credito que llevaria el saldo fuera del rango seguro es 422 y no cambia nada', async () => {
      const { useCase, store } = setup()
      store.accounts.set('sub-1', {
        balance: Number.MAX_SAFE_INTEGER - 10,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })

      await expect(useCase.execute(input({ creditsAmount: 11 }))).rejects.toThrow(
        InvalidMissionRewardAmountError,
      )
      expect(store.accounts.get('sub-1')?.balance).toBe(Number.MAX_SAFE_INTEGER - 10)
    })

    it.each([
      ['schemaVersion distinta', { schemaVersion: 2 }],
      ['schemaVersion ausente', { schemaVersion: undefined }],
      ['reason de batalla', { reason: 'BATTLE_REWARD' }],
      ['reason ausente', { reason: undefined }],
      ['dificultad desconocida', { difficulty: 'EASY' }],
      ['dificultad en minusculas', { difficulty: 'normal' }],
      ['importe de texto', { creditsAmount: '50' }],
      ['importe nulo', { creditsAmount: null }],
      ['instante que no es texto', { occurredAt: 1_790_000_000_000 }],
      ['instante invalido', { occurredAt: 'ayer' }],
      ['jugador en blanco', { playerId: '   ' }],
      ['jugador ausente', { playerId: undefined }],
      ['matricula ausente', { enrollmentId: undefined }],
      ['mision ausente', { missionId: undefined }],
      ['grupo de recompensa de XP', { rewardKey: 'completion:xp' }],
      ['grupo desconocido', { rewardKey: 'bonus:credits' }],
      ['rewardKey sin clave', { rewardKey: 'guaranteed' }],
      [
        'operationId que no es el de la matricula y la linea',
        { operationId: 'battle:room-1:player:sub-1:credit' },
      ],
      [
        'operationId de otra matricula',
        { operationId: 'mission:enr_otra:reward:guaranteed:credits' },
      ],
    ])('rechaza con SCHEMA_INVALID: %s', async (_label, overrides) => {
      const { useCase, store } = setup()

      await expect(useCase.execute(input(overrides))).rejects.toThrow(MissionRewardSchemaError)
      expect(store.accounts.size).toBe(0)
    })
  })

  describe('aislamiento de HU-22: una mision NO es una victoria JcJ', () => {
    const seed = (store: InMemoryWalletStore, weekIdentity = '2026-09-21') =>
      store.accounts.set('sub-1', {
        balance: 30,
        reserved: 0,
        victoryProgress: 19,
        weeklyChestCount: 1,
        weekIdentity,
      })

    it('el credito de mision NO cambia progreso de victoria, cofres ni semana', async () => {
      const { useCase, store } = setup()
      seed(store)

      const result = await useCase.execute(input({ creditsAmount: 50 }))

      expect(result.balance).toBe(80)
      expect(store.accounts.get('sub-1')).toEqual({
        balance: 80,
        reserved: 0,
        victoryProgress: 19, // no sube: un credito de mision no es una victoria
        weeklyChestCount: 1, // no se consume el limite semanal
        weekIdentity: '2026-09-21',
      })
      expect(result).not.toHaveProperty('chestEarned')
    })

    it('a un credito de victoria del cofre, una mision NO lo provoca', async () => {
      const { useCase, store } = setup()
      store.accounts.set('sub-1', {
        balance: 0,
        reserved: 0,
        victoryProgress: 19,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })

      // Cualquier importe, incluso uno que "pasaria de 20" si fuera una victoria.
      await useCase.execute(input({ creditsAmount: 500 }))

      expect(store.accounts.get('sub-1')).toMatchObject({
        victoryProgress: 19,
        weeklyChestCount: 0,
      })
    })

    it('BORDE DE SEMANA: con la cuenta en una semana anterior, la mision NO hace rollover', async () => {
      // "Ahora" ya es la semana siguiente, pero la cuenta sigue con la semana vieja
      // y su contador de cofres lleno: el rollover perezoso es de HU-22 y una
      // mision no lo dispara.
      const { useCase, store } = setup(NEXT_WEEK)
      store.accounts.set('sub-1', {
        balance: 30,
        reserved: 0,
        victoryProgress: 12,
        weeklyChestCount: 2,
        weekIdentity: '2026-09-21',
      })

      await useCase.execute(input())

      expect(store.accounts.get('sub-1')).toEqual({
        balance: 80,
        reserved: 0,
        victoryProgress: 12,
        weeklyChestCount: 2,
        weekIdentity: '2026-09-21', // sigue siendo la vieja
      })
    })

    it('HU-22 sigue igual despues de una mision: la batalla que lleva a 20 SI da cofre', async () => {
      const { useCase, store, battle } = setup()
      seed(store)
      await useCase.execute(input({ creditsAmount: 50 }))

      const reward = await battle.execute({
        operationId: 'battle:room-1:player:sub-1:credit',
        playerId: 'sub-1',
        battleId: 'room-1',
        reason: 'BATTLE_REWARD',
        creditsAmount: 2,
        victoryCreditsAmount: 2,
        occurredAt: MID_WEEK,
      })

      // 19 + 2 = 21 >= 20 -> cofre; el saldo suma lo de la mision y lo de la batalla.
      expect(reward).toMatchObject({
        chestEarned: true,
        balance: 30 + 50 + 2,
        weeklyChestCount: 2,
      })
    })

    it('el credito de mision no altera el saldo reservado', async () => {
      const { useCase, store } = setup()
      store.accounts.set('sub-1', {
        balance: 100,
        reserved: 40,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })

      await useCase.execute(input())

      expect(store.accounts.get('sub-1')).toMatchObject({ balance: 150, reserved: 40 })
    })
  })
})
