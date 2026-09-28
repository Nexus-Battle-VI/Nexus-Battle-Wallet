import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { AppModule, IN_MEMORY_WALLET_STORE } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Contrato HTTP interno de los creditos de mision (HU-10, Task HU-10.3;
 * `hu-10-mission-completion-reward-v1` §9) y su frontera con HU-22.
 *
 * El punto critico es la AUTORIZACION POR RUTA (hallazgo de HU-10.1):
 *   - `mission-reward` responde SOLO a `missions`;
 *   - `battle-reward` responde SOLO a `combat` (antes, con `@InternalOnly()` a
 *     secas, tambien admitia a `missions` y `auction`).
 * Ademas: HMAC, sello, secreto ausente (falla cerrado), codigos del contrato y que
 * una mision no toque el progreso de victoria ni los cofres.
 */
const SECRET = 'secreto-de-integracion-wallet-hu10'
const MISSION_PATH = '/api/internal/v1/wallet/credits/mission-reward'
const BATTLE_PATH = '/api/internal/v1/wallet/credits/battle-reward'

const withEnv = (values: Record<string, string | undefined>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

const buildApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()

  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  await app.init()

  return app
}

/**
 * Cada jugador de prueba tiene SU matricula: la app y su almacen son compartidos por
 * toda la suite, y un mismo `operationId` con otro jugador seria (con razon) un 409.
 */
const missionBody = (overrides: Record<string, unknown> = {}) => {
  const playerId = typeof overrides.playerId === 'string' ? overrides.playerId : 'sub-http-mision'
  const enrollmentId =
    typeof overrides.enrollmentId === 'string' ? overrides.enrollmentId : `enr-${playerId}`

  return {
    schemaVersion: 1,
    operationId: `mission:${enrollmentId}:reward:guaranteed:credits`,
    playerId,
    reason: 'MISSION_REWARD',
    enrollmentId,
    missionId: 'msn_templo_olvidado',
    difficulty: 'NORMAL',
    rewardKey: 'guaranteed:credits',
    creditsAmount: 50,
    occurredAt: '2026-10-02T03:00:05.000Z',
    ...overrides,
  }
}

const operationOf = (playerId: string): string =>
  `mission:enr-${playerId}:reward:guaranteed:credits`

const battleBody = (overrides: Record<string, unknown> = {}) => ({
  operationId: 'battle:room-http:player:sub-http-batalla:credit',
  playerId: 'sub-http-batalla',
  battleId: 'room-http',
  reason: 'BATTLE_REWARD',
  creditsAmount: 2,
  victoryCreditsAmount: 2,
  occurredAt: '2026-09-22T15:00:00.000Z',
  ...overrides,
})

describe('POST /internal/v1/wallet/credits/mission-reward (HU-10.3)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'disabled',
      PERSISTENCE_DRIVER: 'memory',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      STAKE_EXPIRY_INTERVAL_MS: '0',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const store = (): InMemoryWalletStore => app.get(IN_MEMORY_WALLET_STORE)

  const call = (
    path: string,
    body: Record<string, unknown>,
    service = 'missions',
    options: { timestamp?: string; signature?: string; target?: INestApplication } = {},
  ) => {
    const timestamp = options.timestamp ?? String(Date.now())
    const signature =
      options.signature ??
      signInternalRequest(SECRET, { service, method: 'POST', path, timestamp, body })

    return request((options.target ?? app).getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
      .send(body)
  }

  describe('contrato', () => {
    it('missions acredita y la respuesta es SOLO operationId, applied y balance', async () => {
      const response = await call(MISSION_PATH, missionBody({ playerId: 'sub-http-uno' }))

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        operationId: operationOf('sub-http-uno'),
        applied: true,
        balance: 50,
      })
    })

    it('el replay exacto responde 200 applied:false con el MISMO balance y no suma', async () => {
      await call(MISSION_PATH, missionBody({ playerId: 'sub-http-replay' }))

      const replay = await call(MISSION_PATH, missionBody({ playerId: 'sub-http-replay' }))

      expect(replay.status).toBe(200)
      expect(replay.body).toEqual({
        operationId: operationOf('sub-http-replay'),
        applied: false,
        balance: 50,
      })
      expect(store().accounts.get('sub-http-replay')?.balance).toBe(50)
    })

    it('el mismo operationId con otro cuerpo responde 409 OPERATION_CONFLICT y no sobrescribe', async () => {
      await call(MISSION_PATH, missionBody({ playerId: 'sub-http-conflicto' }))

      const conflict = await call(
        MISSION_PATH,
        missionBody({ playerId: 'sub-http-conflicto', creditsAmount: 99 }),
      )

      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('OPERATION_CONFLICT')
      expect(store().accounts.get('sub-http-conflicto')?.balance).toBe(50)
    })

    it.each([0, -3, 1.5])(
      'un importe que incumple la regla responde 422 MISSION_REWARD_INVALID: %s',
      async (creditsAmount) => {
        const response = await call(
          MISSION_PATH,
          missionBody({ playerId: 'sub-http-422', creditsAmount }),
        )

        expect(response.status).toBe(422)
        expect(response.body.code).toBe('MISSION_REWARD_INVALID')
        expect(store().accounts.has('sub-http-422')).toBe(false)
      },
    )

    it.each([
      ['schemaVersion distinta', { schemaVersion: 2 }],
      ['reason de batalla', { reason: 'BATTLE_REWARD' }],
      ['dificultad desconocida', { difficulty: 'EASY' }],
      ['importe de texto', { creditsAmount: '50' }],
      ['instante invalido', { occurredAt: 'ayer' }],
      ['operationId que no es el de la matricula y la linea', { operationId: 'cualquiera' }],
    ])(
      'un cuerpo fuera del contrato (%s) responde 400 SCHEMA_INVALID',
      async (_label, overrides) => {
        const response = await call(
          MISSION_PATH,
          missionBody({ playerId: 'sub-http-400', ...overrides }),
        )

        expect(response.status).toBe(400)
        expect(response.body.code).toBe('SCHEMA_INVALID')
        expect(store().accounts.has('sub-http-400')).toBe(false)
      },
    )

    it('un campo que el contrato no declara responde 400 (p. ej. victoryCreditsAmount)', async () => {
      const response = await call(
        MISSION_PATH,
        missionBody({ playerId: 'sub-http-extra', victoryCreditsAmount: 2 }),
      )

      expect(response.status).toBe(400)
      expect(store().accounts.has('sub-http-extra')).toBe(false)
    })

    it('NO cambia el progreso de victoria, los cofres ni la semana', async () => {
      store().accounts.set('sub-http-jcj', {
        balance: 30,
        reserved: 0,
        victoryProgress: 19,
        weeklyChestCount: 1,
        weekIdentity: '2026-01-05', // una semana MUY anterior: no debe haber rollover
      })

      const response = await call(MISSION_PATH, missionBody({ playerId: 'sub-http-jcj' }))

      expect(response.body).toEqual({
        operationId: operationOf('sub-http-jcj'),
        applied: true,
        balance: 80,
      })
      expect(store().accounts.get('sub-http-jcj')).toEqual({
        balance: 80,
        reserved: 0,
        victoryProgress: 19,
        weeklyChestCount: 1,
        weekIdentity: '2026-01-05',
      })
    })
  })

  describe('autorizacion por ruta (hallazgo de HU-10.1)', () => {
    it('missions -> mission-reward: PERMITIDO', async () => {
      expect(
        (await call(MISSION_PATH, missionBody({ playerId: 'sub-http-a' }), 'missions')).status,
      ).toBe(200)
    })

    it.each(['combat', 'auction'])('%s -> mission-reward: RECHAZADO (401)', async (service) => {
      const response = await call(MISSION_PATH, missionBody({ playerId: 'sub-http-b' }), service)

      expect(response.status).toBe(401)
      expect(store().accounts.has('sub-http-b')).toBe(false)
    })

    it('combat -> battle-reward: PERMITIDO (HU-22 sigue igual)', async () => {
      const response = await call(BATTLE_PATH, battleBody(), 'combat')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ applied: true, balance: 2, victoryProgress: 2 })
    })

    it.each(['missions', 'auction'])('%s -> battle-reward: RECHAZADO (401)', async (service) => {
      const response = await call(
        BATTLE_PATH,
        battleBody({
          operationId: 'battle:room-x:player:sub-http-c:credit',
          playerId: 'sub-http-c',
        }),
        service,
      )

      expect(response.status).toBe(401)
      expect(store().accounts.has('sub-http-c')).toBe(false)
    })

    it.each([MISSION_PATH, BATTLE_PATH])(
      'un servicio desconocido -> %s: RECHAZADO (401)',
      async (path) => {
        const body =
          path === MISSION_PATH
            ? missionBody({ playerId: 'sub-http-d' })
            : battleBody({ playerId: 'sub-http-d' })

        expect((await call(path, body, 'web')).status).toBe(401)
        expect((await call(path, body, 'catalog')).status).toBe(401)
      },
    )
  })

  describe('HMAC y fallo cerrado', () => {
    it('sin cabeceras internas responde 401', async () => {
      const response = await request(app.getHttpServer())
        .post(MISSION_PATH)
        .send(missionBody({ playerId: 'sub-http-e' }))

      expect(response.status).toBe(401)
    })

    it('una firma que no corresponde al cuerpo responde 401 y no acredita', async () => {
      const timestamp = String(Date.now())
      const signature = signInternalRequest(SECRET, {
        service: 'missions',
        method: 'POST',
        path: MISSION_PATH,
        timestamp,
        body: missionBody({ playerId: 'sub-http-f', creditsAmount: 1 }),
      })

      const response = await call(
        MISSION_PATH,
        missionBody({ playerId: 'sub-http-f', creditsAmount: 999 }),
        'missions',
        { timestamp, signature },
      )

      expect(response.status).toBe(401)
      expect(store().accounts.has('sub-http-f')).toBe(false)
    })

    it('un sello fuera de la ventana responde 401', async () => {
      const response = await call(
        MISSION_PATH,
        missionBody({ playerId: 'sub-http-g' }),
        'missions',
        { timestamp: String(Date.now() - 10 * 60_000) },
      )

      expect(response.status).toBe(401)
    })

    it('una firma hecha con otro secreto responde 401', async () => {
      const timestamp = String(Date.now())
      const body = missionBody({ playerId: 'sub-http-h' })
      const signature = signInternalRequest('otro-secreto', {
        service: 'missions',
        method: 'POST',
        path: MISSION_PATH,
        timestamp,
        body,
      })

      expect((await call(MISSION_PATH, body, 'missions', { timestamp, signature })).status).toBe(
        401,
      )
    })

    it('sin secreto configurado el contrato interno NIEGA (falla cerrado, 503)', async () => {
      const restoreClosed = withEnv({ INTERNAL_SERVICE_AUTH_SECRET: undefined })
      const closed = await buildApp()

      try {
        const response = await call(
          MISSION_PATH,
          missionBody({ playerId: 'sub-http-i' }),
          'missions',
          { target: closed },
        )

        expect(response.status).toBe(503)
        expect(response.body.balance).toBeUndefined()
      } finally {
        await closed.close()
        restoreClosed()
      }
    })
  })
})
