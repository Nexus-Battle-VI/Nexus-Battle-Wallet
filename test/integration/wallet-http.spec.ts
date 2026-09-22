import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador-1': { subject: 'sub-1', email: null, roles: new Set([Role.Player]) },
  'token-jugador-2': { subject: 'sub-2', email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const SECRET = 'secreto-de-integracion-wallet'

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

const buildApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)
    .compile()

  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  await app.init()

  return app
}

describe('Wallet HTTP (HU-22)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      PERSISTENCE_DRIVER: 'memory',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const internalPath = '/api/internal/v1/wallet/credits/battle-reward'

  const creditBody = (overrides: Record<string, unknown> = {}) => ({
    operationId: 'battle:room-1:player:sub-basic:credit',
    playerId: 'sub-basic',
    battleId: 'room-1',
    reason: 'BATTLE_REWARD',
    creditsAmount: 2,
    victoryCreditsAmount: 2,
    occurredAt: '2026-09-22T15:00:00.000Z',
    ...overrides,
  })

  const signedCredit = (body: Record<string, unknown>, service = 'combat') => {
    const timestamp = String(Date.now())

    return request(app.getHttpServer())
      .post(internalPath)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(SECRET, {
          service,
          method: 'POST',
          path: internalPath,
          timestamp,
          body,
        }),
      )
      .send(body)
  }

  describe('POST /internal/v1/wallet/credits/battle-reward', () => {
    it('rechaza sin firma HMAC', async () => {
      const response = await request(app.getHttpServer()).post(internalPath).send(creditBody())
      expect(response.status).toBe(401)
    })

    it('rechaza a un servicio no autorizado (ej. catalog)', async () => {
      const response = await signedCredit(
        creditBody({ operationId: 'op-otro-servicio' }),
        'catalog',
      )
      expect(response.status).toBe(401)
    })

    it('combat acredita con firma valida', async () => {
      const response = await signedCredit(creditBody())

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        applied: true,
        balance: 2,
        victoryProgress: 2,
        chestEarned: false,
        weeklyChestLimit: 2,
      })
    })

    it('un retry del mismo operationId con el mismo cuerpo responde applied=false, sin duplicar', async () => {
      const body = creditBody({ operationId: 'op-retry-1', playerId: 'sub-retry' })
      const first = await signedCredit(body)
      const retry = await signedCredit(body)

      expect(first.status).toBe(200)
      expect(retry.status).toBe(200)
      expect(retry.body.applied).toBe(false)
      expect(retry.body.balance).toBe(first.body.balance)
    })

    it('el mismo operationId con otro cuerpo responde 409', async () => {
      const body = creditBody({ operationId: 'op-conflicto-1', playerId: 'sub-conflict' })
      await signedCredit(body)

      const response = await signedCredit({ ...body, creditsAmount: 4, victoryCreditsAmount: 4 })
      expect(response.status).toBe(409)
    })

    it('un monto fuera del catalogo cerrado responde 422', async () => {
      const response = await signedCredit(
        creditBody({
          operationId: 'op-invalido-1',
          playerId: 'sub-invalid',
          creditsAmount: 3,
          victoryCreditsAmount: 0,
        }),
      )
      expect(response.status).toBe(422)
    })

    it('un cuerpo mal formado responde 400 (ValidationPipe)', async () => {
      const response = await signedCredit({ operationId: 'x' })
      expect(response.status).toBe(400)
    })
  })

  describe('GET /v1/wallet/me', () => {
    it('exige testimonio de identidad', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/wallet/me')
      expect(response.status).toBe(401)
    })

    it('devuelve el estado del jugador autenticado, derivado del sub del token', async () => {
      await signedCredit(
        creditBody({ operationId: 'op-me-1', playerId: 'sub-2', battleId: 'room-2' }),
      )

      const response = await request(app.getHttpServer())
        .get('/api/v1/wallet/me')
        .set('Authorization', 'Bearer token-jugador-2')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ balance: 2, victoryProgress: 2, threshold: 20 })
    })

    it('un jugador no puede leer el saldo de otro: siempre lee el suyo propio', async () => {
      // sub-1 (token-jugador-1) nunca recibio un credito en esta suite: su
      // estado debe seguir en 0, sin mezclarse con el saldo de sub-2.
      const response = await request(app.getHttpServer())
        .get('/api/v1/wallet/me')
        .set('Authorization', 'Bearer token-jugador-1')

      expect(response.status).toBe(200)
      expect(response.body.balance).toBe(0)
    })
  })
})
