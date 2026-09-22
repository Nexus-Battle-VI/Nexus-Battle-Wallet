import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule, IN_MEMORY_WALLET_STORE } from '../../src/infrastructure/bootstrap/app.module'

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

describe('Wallet stakes HTTP (HU-23)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      PERSISTENCE_DRIVER: 'memory',
      // El barrido de expiracion no debe correr durante las pruebas.
      STAKE_EXPIRY_INTERVAL_MS: '0',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const store = (): InMemoryWalletStore => app.get<InMemoryWalletStore>(IN_MEMORY_WALLET_STORE)

  const seedBalance = (playerId: string, balance: number): void => {
    store().accounts.set(playerId, {
      balance,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
  }

  const signedPost = (path: string, body: Record<string, unknown>, service = 'combat') => {
    const timestamp = String(Date.now())

    return request(app.getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(SECRET, {
          service,
          method: 'POST',
          path,
          timestamp,
          body,
        }),
      )
      .send(body)
  }

  const reservePath = '/api/internal/v1/wallet/stakes/reserve'
  const releasePath = '/api/internal/v1/wallet/stakes/release'
  const settlePath = '/api/internal/v1/wallet/stakes/settle'

  const holdIdOf = (playerId: string, battleId = 'room-1'): string =>
    `battle:${battleId}:player:${playerId}:stake:reserve`

  const reserveBody = (overrides: Record<string, unknown> = {}) => ({
    operationId: holdIdOf('sub-1'),
    playerId: 'sub-1',
    battleId: 'room-1',
    amount: 10,
    occurredAt: '2026-09-22T10:00:00.000Z',
    ...overrides,
  })

  const releaseBody = (overrides: Record<string, unknown> = {}) => ({
    operationId: 'battle:room-1:player:sub-1:stake:release',
    holdId: holdIdOf('sub-1'),
    reason: 'ROOM_CANCELLED',
    ...overrides,
  })

  describe('POST /internal/v1/wallet/stakes/reserve', () => {
    it('rechaza sin firma HMAC', async () => {
      const response = await request(app.getHttpServer()).post(reservePath).send(reserveBody())
      expect(response.status).toBe(401)
    })

    it('rechaza a un servicio no autorizado (catalog)', async () => {
      const response = await signedPost(reservePath, reserveBody(), 'catalog')
      expect(response.status).toBe(401)
    })

    it('reserva con firma valida: `reserved` sube y `balance` no cambia (S-01, S-18)', async () => {
      seedBalance('sub-1', 100)

      const response = await signedPost(reservePath, reserveBody())

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        operationId: holdIdOf('sub-1'),
        applied: true,
        holdId: holdIdOf('sub-1'),
        balance: 100,
        reserved: 10,
        available: 90,
      })
    })

    it('un retry del mismo operationId con el mismo cuerpo responde applied=false (S-12)', async () => {
      seedBalance('sub-replay', 100)
      const body = reserveBody({
        operationId: holdIdOf('sub-replay'),
        playerId: 'sub-replay',
      })

      const first = await signedPost(reservePath, body)
      const retry = await signedPost(reservePath, body)

      expect(first.status).toBe(200)
      expect(retry.status).toBe(200)
      expect(retry.body).toMatchObject({ applied: false, reserved: 10 })
    })

    it('el mismo operationId con otro monto responde 409 (S-13)', async () => {
      seedBalance('sub-conflict', 100)
      const body = reserveBody({
        operationId: holdIdOf('sub-conflict'),
        playerId: 'sub-conflict',
      })

      await signedPost(reservePath, body)
      const response = await signedPost(reservePath, { ...body, amount: 20 })

      expect(response.status).toBe(409)
      expect(response.body.code).toBe('OPERATION_CONFLICT')
    })

    it('saldo insuficiente responde 422 INSUFFICIENT_AVAILABLE_BALANCE (S-03)', async () => {
      seedBalance('sub-poor', 5)

      const response = await signedPost(
        reservePath,
        reserveBody({ operationId: holdIdOf('sub-poor'), playerId: 'sub-poor', amount: 10 }),
      )

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE')
    })

    it.each([[0], [-5], [1.5]])(
      'un monto invalido (%s) responde 422 INVALID_AMOUNT',
      async (amount) => {
        seedBalance('sub-invalid', 100)

        const response = await signedPost(
          reservePath,
          reserveBody({ operationId: holdIdOf('sub-invalid'), playerId: 'sub-invalid', amount }),
        )

        expect(response.status).toBe(422)
        expect(response.body.code).toBe('INVALID_AMOUNT')
      },
    )

    it('un cuerpo mal formado responde 400 (ValidationPipe)', async () => {
      const response = await signedPost(reservePath, { operationId: 'x' })
      expect(response.status).toBe(400)
    })
  })

  describe('POST /internal/v1/wallet/stakes/release', () => {
    it('libera el hold y devuelve `reserved` a 0 (S-05)', async () => {
      seedBalance('sub-release', 100)
      await signedPost(
        reservePath,
        reserveBody({ operationId: holdIdOf('sub-release'), playerId: 'sub-release' }),
      )

      const response = await signedPost(
        releasePath,
        releaseBody({
          operationId: 'battle:room-1:player:sub-release:stake:release',
          holdId: holdIdOf('sub-release'),
        }),
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ applied: true, reserved: 0, available: 100 })
    })

    it('reintentar la liberacion responde applied=false', async () => {
      seedBalance('sub-release-replay', 100)
      await signedPost(
        reservePath,
        reserveBody({
          operationId: holdIdOf('sub-release-replay'),
          playerId: 'sub-release-replay',
        }),
      )
      const body = releaseBody({
        operationId: 'battle:room-1:player:sub-release-replay:stake:release',
        holdId: holdIdOf('sub-release-replay'),
      })

      const first = await signedPost(releasePath, body)
      const retry = await signedPost(releasePath, body)

      expect(first.body.applied).toBe(true)
      expect(retry.body.applied).toBe(false)
    })

    it('un hold inexistente responde 422 HOLD_NOT_FOUND', async () => {
      const response = await signedPost(
        releasePath,
        releaseBody({ operationId: 'op-no-existe', holdId: 'hold-no-existe' }),
      )

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('HOLD_NOT_FOUND')
    })
  })

  describe('POST /internal/v1/wallet/stakes/settle', () => {
    const seedTwoPlayers = async (battleId: string): Promise<void> => {
      seedBalance('sub-loser', 100)
      seedBalance('sub-winner', 100)
      await signedPost(
        reservePath,
        reserveBody({
          operationId: holdIdOf('sub-loser', battleId),
          playerId: 'sub-loser',
          battleId,
        }),
      )
      await signedPost(
        reservePath,
        reserveBody({
          operationId: holdIdOf('sub-winner', battleId),
          playerId: 'sub-winner',
          battleId,
        }),
      )
    }

    it('1v1 con ganador: mueve los saldos y responde el estado final (S-07)', async () => {
      await seedTwoPlayers('room-1v1')

      const response = await signedPost(settlePath, {
        operationId: 'battle:room-1v1:stakes:settle',
        battleId: 'room-1v1',
        settlements: [
          {
            playerId: 'sub-loser',
            holdId: holdIdOf('sub-loser', 'room-1v1'),
            outcome: 'CAPTURED',
            amount: 10,
          },
          {
            playerId: 'sub-winner',
            holdId: holdIdOf('sub-winner', 'room-1v1'),
            outcome: 'CREDITED',
            amount: 10,
          },
        ],
      })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ applied: true })
      expect(response.body.results).toEqual([
        {
          playerId: 'sub-loser',
          holdId: holdIdOf('sub-loser', 'room-1v1'),
          balance: 90,
          reserved: 0,
          available: 90,
        },
        {
          playerId: 'sub-winner',
          holdId: holdIdOf('sub-winner', 'room-1v1'),
          balance: 110,
          reserved: 0,
          available: 110,
        },
      ])
    })

    it('suma que no cuadra responde 422 SETTLEMENT_NOT_ZERO_SUM (S-15)', async () => {
      await seedTwoPlayers('room-nz')

      const response = await signedPost(settlePath, {
        operationId: 'battle:room-nz:stakes:settle',
        battleId: 'room-nz',
        settlements: [
          {
            playerId: 'sub-loser',
            holdId: holdIdOf('sub-loser', 'room-nz'),
            outcome: 'CAPTURED',
            amount: 10,
          },
          {
            playerId: 'sub-winner',
            holdId: holdIdOf('sub-winner', 'room-nz'),
            outcome: 'CREDITED',
            amount: 8,
          },
        ],
      })

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('SETTLEMENT_NOT_ZERO_SUM')
    })

    it('monto de CAPTURED que no coincide responde 422 HOLD_AMOUNT_MISMATCH', async () => {
      await seedTwoPlayers('room-mm')

      const response = await signedPost(settlePath, {
        operationId: 'battle:room-mm:stakes:settle',
        battleId: 'room-mm',
        settlements: [
          {
            playerId: 'sub-loser',
            holdId: holdIdOf('sub-loser', 'room-mm'),
            outcome: 'CAPTURED',
            amount: 11,
          },
          {
            playerId: 'sub-winner',
            holdId: holdIdOf('sub-winner', 'room-mm'),
            outcome: 'CREDITED',
            amount: 11,
          },
        ],
      })

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('HOLD_AMOUNT_MISMATCH')
    })

    it('un hold inexistente responde 422 HOLD_NOT_FOUND', async () => {
      const response = await signedPost(settlePath, {
        operationId: 'battle:room-x:stakes:settle',
        battleId: 'room-x',
        settlements: [
          { playerId: 'nadie', holdId: 'hold-inexistente', outcome: 'CAPTURED', amount: 1 },
          { playerId: 'otro', holdId: 'hold-inexistente-2', outcome: 'CREDITED', amount: 1 },
        ],
      })

      expect(response.status).toBe(422)
      expect(response.body.code).toBe('HOLD_NOT_FOUND')
    })

    it('un cuerpo mal formado responde 400 (settlements con outcome desconocido)', async () => {
      const response = await signedPost(settlePath, {
        operationId: 'op-x',
        battleId: 'room-x',
        settlements: [{ playerId: 'a', holdId: 'b', outcome: 'RARO', amount: 1 }],
      })

      expect(response.status).toBe(400)
    })
  })

  describe('GET /v1/wallet/me', () => {
    it('refleja `reserved`/`available` con una reserva activa (S-18)', async () => {
      seedBalance('sub-2', 100)
      await signedPost(
        reservePath,
        reserveBody({ operationId: holdIdOf('sub-2'), playerId: 'sub-2', amount: 30 }),
      )

      const response = await request(app.getHttpServer())
        .get('/api/v1/wallet/me')
        .set('Authorization', 'Bearer token-jugador-2')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ balance: 100, reserved: 30, available: 70 })
    })
  })
})
