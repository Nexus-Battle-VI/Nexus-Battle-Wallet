import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import {
  AppModule,
  APP_CONFIG,
  IN_MEMORY_WALLET_STORE,
} from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'

const secret = 'tournament-entry-fee-hmac-secret'

describe('Wallet tournament entry fees HTTP (HU-84)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      PERSISTENCE_DRIVER: 'memory',
      INTERNAL_SERVICE_AUTH_SECRET: secret,
      STAKE_EXPIRY_INTERVAL_MS: '0',
      LOG_LEVEL: 'error',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })
  afterAll(async () => app.close())

  const store = (): InMemoryWalletStore => app.get(IN_MEMORY_WALLET_STORE)
  const account = (playerId: string, balance: number, reserved = 0): void => {
    store().accounts.set(playerId, {
      balance,
      reserved,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
  }
  const call = (path: string, body: Record<string, unknown>, service = 'tournament') => {
    const timestamp = String(Date.now())
    const signature = signInternalRequest(secret, {
      service,
      method: 'POST',
      path,
      timestamp,
      body,
    })
    return request(app.getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
      .send(body)
  }
  const chargePath = '/api/internal/v1/wallet/tournament-entry-fees'
  const charge = (operationId: string, payerId: string, amount: number) =>
    call(chargePath, { operationId, payerId, tournamentId: 'T1', teamId: 'team1', amount })

  it('accepts a valid Tournament HMAC charge and replays it without a second debit', async () => {
    account('http-fee-charge', 100)
    const first = await charge('http-charge-1', 'http-fee-charge', 30)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      chargeId: 'http-charge-1',
      status: 'CHARGED',
      applied: true,
    })
    const replay = await charge('http-charge-1', 'http-fee-charge', 30)
    expect(replay.status).toBe(200)
    expect(replay.body.applied).toBe(false)
    expect(store().accounts.get('http-fee-charge')).toMatchObject({ balance: 70 })
  })

  it('rejects missing, foreign-caller, and invalid HMAC signatures', async () => {
    const body = {
      operationId: 'http-auth',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'http-auth-seller',
      amount: 1,
    }
    expect((await request(app.getHttpServer()).post(chargePath).send(body)).status).toBe(401)
    expect((await call(chargePath, body, 'combat')).status).toBe(401)
    const invalid = await request(app.getHttpServer())
      .post(chargePath)
      .set('x-internal-service', 'auction')
      .set('x-internal-timestamp', String(Date.now()))
      .set('x-internal-signature', 'invalid')
      .send(body)
    expect(invalid.status).toBe(401)
  })

  it('maps charge conflicts and insufficient available balance', async () => {
    account('http-fee-conflict', 100)
    await charge('http-conflict', 'http-fee-conflict', 10)
    const conflict = await charge('http-conflict', 'http-fee-conflict', 11)
    expect(conflict.status).toBe(409)
    account('http-fee-reserved', 100, 90)
    const insufficient = await charge('http-insufficient', 'http-fee-reserved', 20)
    expect(insufficient.status).toBe(422)
  })

  it('refunds once, replays, and accepts another operation for an already refunded fee', async () => {
    account('http-fee-refund', 100)
    await charge('http-charge-refund', 'http-fee-refund', 30)
    const path = `${chargePath}/http-charge-refund/refunds`
    const first = await call(path, { operationId: 'http-r1' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ status: 'REFUNDED', applied: true })
    const replay = await call(path, { operationId: 'http-r1' })
    expect(replay.body.applied).toBe(false)
    expect(replay.body.operationId).toBe('http-r1')
    expect(replay.body.chargeId).toBe('http-charge-refund')
    const another = await call(path, { operationId: 'http-r2' })
    expect(another.body).toMatchObject({ status: 'REFUNDED', applied: false })
    expect(store().accounts.get('http-fee-refund')).toMatchObject({ balance: 100 })
  })

  it('rejects cross-fee refund operation reuse, unknown fees, and invalid DTOs', async () => {
    account('http-fee-other', 100)
    await charge('http-charge-other', 'http-fee-other', 10)
    const reuse = await call(`${chargePath}/http-charge-other/refunds`, { operationId: 'http-r2' })
    expect(reuse.status).toBe(409)
    const missing = await call(`${chargePath}/missing/refunds`, { operationId: 'http-missing' })
    expect(missing.status).toBe(404)
    const invalid = await call(chargePath, {
      operationId: '',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'x',
      amount: 0,
    })
    expect(invalid.status).toBe(400)
  })

  it.each([
    '/api/internal/v1/wallet/credits/battle-reward',
    '/api/internal/v1/wallet/credits/mission-reward',
    '/api/internal/v1/wallet/stakes/reserve',
    '/api/internal/v1/wallet/holds',
    '/api/internal/v1/wallet/buy-now-transfers',
    '/api/internal/v1/wallet/auction-publication-fees',
  ])('el caller tournament no recibe permiso para otra ruta %s', async (path) => {
    expect((await call(path, {})).status).toBe(401)
  })

  it('rechaza un cuerpo alterado después de firmar y un sello caducado sin mover saldo', async () => {
    account('http-auth-tamper', 120)
    const body = {
      operationId: 'http-tamper',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'http-auth-tamper',
      amount: 100,
    }
    const timestamp = String(Date.now())
    const signature = signInternalRequest(secret, {
      service: 'tournament',
      method: 'POST',
      path: chargePath,
      timestamp,
      body,
    })
    const altered = await request(app.getHttpServer())
      .post(chargePath)
      .set('x-internal-service', 'tournament')
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
      .send({ ...body, amount: 1 })
    expect(altered.status).toBe(401)
    const expired = String(Date.now() - 600_000)
    const expiredSignature = signInternalRequest(secret, {
      service: 'tournament',
      method: 'POST',
      path: chargePath,
      timestamp: expired,
      body,
    })
    expect(
      (
        await request(app.getHttpServer())
          .post(chargePath)
          .set('x-internal-service', 'tournament')
          .set('x-internal-timestamp', expired)
          .set('x-internal-signature', expiredSignature)
          .send(body)
      ).status,
    ).toBe(401)
    expect(store().accounts.get('http-auth-tamper')?.balance).toBe(120)
    expect(store().entryFees.has('http-tamper')).toBe(false)
  })

  it('99/100 devuelve rechazo durable sin ledger; recargar no cambia el replay', async () => {
    account('http-99', 99)
    const rejected = await charge('http-99-charge', 'http-99', 100)
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('INSUFFICIENT_BALANCE')
    expect(store().accounts.get('http-99')?.balance).toBe(99)
    account('http-99', 120)
    expect((await charge('http-99-charge', 'http-99', 100)).status).toBe(422)
    expect(store().accounts.get('http-99')?.balance).toBe(120)
    expect(store().entryFeeLedger.has('http-99-charge')).toBe(false)
    const refund = await call(`${chargePath}/http-99-charge/refunds`, {
      operationId: 'http-99-refund',
    })
    expect(refund.status).toBe(404)
    expect(refund.body.code).toBe('CHARGE_NOT_FOUND')
  })

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza tarifa %s sin crear movimiento',
    async (amount) => {
      account('http-invalid-amount', 120)
      expect(
        (await charge(`invalid-amount-${String(amount)}`, 'http-invalid-amount', amount)).status,
      ).toBe(400)
      expect(store().accounts.get('http-invalid-amount')?.balance).toBe(120)
    },
  )

  it('rechaza campos adicionales del navegador y pagador/importe en devolución', async () => {
    const body = {
      operationId: 'web-arbitrary',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'http-fee-charge',
      amount: 1,
      method: 'SIMULATED_MONEY',
    }
    expect((await call(chargePath, body)).status).toBe(400)
    const refund = await call(`${chargePath}/http-charge-1/refunds`, {
      operationId: 'web-refund',
      payerId: 'other',
      amount: 200,
    })
    expect(refund.status).toBe(400)
    expect(store().entryFees.has('web-arbitrary')).toBe(false)
  })
})
