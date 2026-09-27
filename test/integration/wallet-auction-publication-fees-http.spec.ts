import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { AppModule, IN_MEMORY_WALLET_STORE } from '../../src/infrastructure/bootstrap/app.module'

const secret = 'auction-publication-fee-hmac-secret'

describe('Wallet publication fees HTTP (HU-62)', () => {
  let app: INestApplication

  beforeAll(async () => {
    Object.assign(process.env, {
      AUTH_MODE: 'disabled',
      PERSISTENCE_DRIVER: 'memory',
      INTERNAL_SERVICE_AUTH_SECRET: secret,
      STAKE_EXPIRY_INTERVAL_MS: '0',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
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
  const call = (path: string, body: Record<string, unknown>, service = 'auction') => {
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
  const chargePath = '/api/internal/v1/wallet/auction-publication-fees'
  const charge = (operationId: string, sellerId: string, amount: number) =>
    call(chargePath, { operationId, sellerId, amount })

  it('accepts a valid Auction HMAC charge and replays it without a second debit', async () => {
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
    const body = { operationId: 'http-auth', sellerId: 'http-auth-seller', amount: 1 }
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
    const invalid = await call(chargePath, { operationId: '', sellerId: 'x', amount: 0 })
    expect(invalid.status).toBe(400)
  })
})
