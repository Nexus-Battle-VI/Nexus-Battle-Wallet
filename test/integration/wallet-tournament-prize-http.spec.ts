import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import request from 'supertest'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { qaTournamentPrize } from '../support/tournament-prize'

describe('HTTP/HMAC HU-86: seguridad, DTO y documentación', () => {
  let app: INestApplication
  const secret = 'qa-wallet-prize-test-only'
  const path = '/api/internal/v1/wallet/credits/tournament-prize'
  const body = qaTournamentPrize('http-security')
  const boot = async (configuredSecret = secret) => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(
        loadConfig({
          NODE_ENV: 'test',
          AUTH_MODE: 'jwt',
          COGNITO_USER_POOL_ID: 'us-east-1_qa',
          COGNITO_CLIENT_ID: 'qa-client',
          PERSISTENCE_DRIVER: 'memory',
          INTERNAL_SERVICE_AUTH_SECRET: configuredSecret,
          STAKE_EXPIRY_INTERVAL_MS: '0',
          LOG_LEVEL: 'error',
        }),
      )
      .compile()
    const instance = module.createNestApplication()
    instance.setGlobalPrefix('api')
    instance.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await instance.init()
    return instance
  }
  const call = (
    input: unknown,
    service = 'tournament',
    signingSecret = secret,
    timestamp = String(Date.now()),
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(signingSecret, {
          service,
          method: 'POST',
          path,
          timestamp,
          body: input,
        }),
      )
      .send(input as object)
  beforeAll(async () => {
    app = await boot()
  })
  afterAll(async () => {
    await app.close()
  })
  it('no permite confirmar premios usando persistencia en memoria', async () => {
    const response = await call(body)
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('PRIZE_DEPENDENCY_UNAVAILABLE')
  })
  it('valida null explícito por ausencia y rechaza la sala omitida o vacía', async () => {
    expect((await call({ ...body, finalRoomId: null })).status).toBe(503)
    expect((await call({ ...body, finalRoomId: '' })).status).toBe(400)
    const missing = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'finalRoomId'),
    )
    expect((await call(missing)).status).toBe(400)
  })
  it.each(['combat', 'missions', 'auction', 'unknown'])(
    'rechaza HMAC válido de %s',
    async (caller) => {
      expect((await call(body, caller)).status).toBe(401)
    },
  )
  it('rechaza ausencia de identidad, firma incorrecta y timestamp caducado', async () => {
    expect((await request(app.getHttpServer()).post(path).send(body)).status).toBe(401)
    expect((await call(body, 'tournament', 'wrong-qa-secret')).status).toBe(401)
    expect((await call(body, 'tournament', secret, '1')).status).toBe(401)
  })
  it.each([
    { ...body, playerId: 2 },
    { ...body, heroId: ' ' },
    { ...body, kind: 'EPIC' },
    { ...body, amount: 501 },
    { ...body, productId: 'epic' },
    { ...body, championTeamId: 'x'.repeat(161) },
    { ...body, actor: 'qa-admin' },
    { ...body, receiptId: 'forged' },
    { ...body, status: 'DELIVERED' },
  ])('rechaza schema y campos ajenos %#', async (input) => {
    const result = await call(input)
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('SCHEMA_INVALID')
  })
  it('exige productId explícitamente nulo y monto positivo canónico', async () => {
    const missing = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'productId'))
    expect((await call(missing)).body.code).toBe('SCHEMA_INVALID')
    for (const amount of ['0', '1.5', '01', '9007199254740992']) {
      const response = await call({ ...body, amount })
      expect(response.status).toBe(422)
      expect(response.body.code).toBe('PRIZE_INVALID')
    }
  })
  it('OpenAPI incluye los diez campos, recibo y errores del endpoint real', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('qa').setVersion('qa').build(),
    )
    expect(doc.paths[path]?.post?.responses).toMatchObject({
      '200': {},
      '400': {},
      '401': {},
      '409': {},
      '422': {},
      '503': {},
    })
    expect(doc.components?.schemas?.CreditTournamentPrizeDto).toMatchObject({
      required: Object.keys(body),
    })
    expect(doc.components?.schemas?.TournamentPrizeReceiptDto).toMatchObject({
      required: expect.arrayContaining(['receiptId', 'status']),
    })
  })
  it('sin secreto HMAC se deniega incluso con caller y firma', async () => {
    await app.close()
    app = await boot('')
    expect((await call(body)).status).toBe(503)
  })
})
