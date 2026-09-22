import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { AppModule, IN_MEMORY_WALLET_STORE } from '../../src/infrastructure/bootstrap/app.module'

const secret = 'auction-hmac-secret'
describe('Wallet Auction holds HTTP (HU-65)', () => {
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
  const post = (path: string, body: Record<string, unknown>, service = 'auction') => {
    const timestamp = String(Date.now())
    return request(app.getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(secret, { service, method: 'POST', path, timestamp, body }),
      )
      .send(body)
  }
  const reserve = (id = 'hold-1') => ({
    operationId: id,
    playerId: 'buyer',
    amount: 30,
    auctionId: 'auction-1',
    bidId: 'bid-1',
    auctionClosesAt: new Date(Date.now() + 60000).toISOString(),
  })
  it('auction creates, replays and captures a hold using its stored amount', async () => {
    store().accounts.set('buyer', {
      balance: 100,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
    store().accounts.set('seller', {
      balance: 20,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
    const body = reserve()
    const first = await post('/api/internal/v1/wallet/holds', body)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      operationId: 'hold-1',
      holdId: 'hold-1',
      holdStatus: 'ACTIVE',
      applied: true,
    })
    expect((await post('/api/internal/v1/wallet/holds', body)).body.applied).toBe(false)
    const malformedCapture = {
      operationId: 'capture-1',
      beneficiaryPlayerId: 'seller',
      auctionId: 'auction-1',
      winningBidId: 'bid-1',
      amount: 999,
    }
    const done = await post('/api/internal/v1/wallet/holds/hold-1/captures', malformedCapture)
    expect(done.status).toBe(400)
    const capture = {
      operationId: 'capture-1',
      beneficiaryPlayerId: 'seller',
      auctionId: 'auction-1',
      winningBidId: 'bid-1',
    }
    const accepted = await post('/api/internal/v1/wallet/holds/hold-1/captures', capture)
    expect(accepted.body).toMatchObject({ holdStatus: 'CAPTURED', beneficiaryPlayerId: 'seller' })
    expect(store().accounts.get('buyer')).toMatchObject({ balance: 70, reserved: 0 })
    expect(store().accounts.get('seller')).toMatchObject({ balance: 50 })
    expect(
      (await post('/api/internal/v1/wallet/holds/hold-1/captures', capture)).body.applied,
    ).toBe(false)
  })
  it('enforces HMAC callers and supports release', async () => {
    store().accounts.set('release-buyer', {
      balance: 100,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-21',
    })
    const body = { ...reserve('release-hold'), playerId: 'release-buyer' }
    expect((await post('/api/internal/v1/wallet/holds', body, 'combat')).status).toBe(401)
    expect((await post('/api/internal/v1/wallet/holds', body, 'unknown')).status).toBe(401)
    await post('/api/internal/v1/wallet/holds', body)
    const released = await post('/api/internal/v1/wallet/holds/release-hold/releases', {
      operationId: 'release-1',
      reason: 'AUCTION_OUTBID',
    })
    expect(released.status).toBe(200)
    expect(store().accounts.get('release-buyer')).toMatchObject({ balance: 100, reserved: 0 })
    expect(
      (
        await post(
          '/api/internal/v1/wallet/stakes/reserve',
          {
            operationId: 'x',
            playerId: 'x',
            battleId: 'x',
            amount: 1,
            occurredAt: new Date().toISOString(),
          },
          'auction',
        )
      ).status,
    ).toBe(401)
  })
})
