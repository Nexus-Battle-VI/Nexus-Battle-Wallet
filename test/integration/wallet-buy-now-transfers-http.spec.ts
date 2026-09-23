import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
import { AppModule, IN_MEMORY_WALLET_STORE } from '../../src/infrastructure/bootstrap/app.module'

const secret = 'auction-hmac-secret'

describe('Wallet compra inmediata HTTP (HU-64.8)', () => {
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

  const call = (
    method: 'get' | 'post',
    path: string,
    body: Record<string, unknown> = {},
    service = 'auction',
  ) => {
    const timestamp = String(Date.now())
    const signature = signInternalRequest(secret, { service, method: method.toUpperCase(), path, timestamp, body })
    const req = request(app.getHttpServer())
      [method](path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)

    return method === 'post' ? req.send(body) : req
  }

  const account = (
    playerId: string,
    balance: number,
    reserved = 0,
  ): void => {
    store().accounts.set(playerId, {
      balance,
      reserved,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-09-23',
    })
  }

  it('reporta el saldo disponible de un jugador por su id', async () => {
    account('comprador-saldo', 5000, 1200)

    const response = await call(
      'get',
      '/api/internal/v1/wallet/buy-now-transfers/balance/comprador-saldo',
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      playerId: 'comprador-saldo',
      balance: 5000,
      reserved: 1200,
      available: 3800,
    })
  })

  it('transfiere, replica el reintento y revierte', async () => {
    account('comprador-1', 5000)
    account('vendedor-1', 1000)

    const transferBody = {
      operationId: 'buy-now-1',
      buyerId: 'comprador-1',
      sellerId: 'vendedor-1',
      amount: 2500,
    }

    const first = await call('post', '/api/internal/v1/wallet/buy-now-transfers', transferBody)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      operationId: 'buy-now-1',
      transferId: 'buy-now-1',
      status: 'APPLIED',
      applied: true,
    })
    expect(store().accounts.get('comprador-1')).toMatchObject({ balance: 2500 })
    expect(store().accounts.get('vendedor-1')).toMatchObject({ balance: 3500 })

    const replay = await call('post', '/api/internal/v1/wallet/buy-now-transfers', transferBody)
    expect(replay.body.applied).toBe(false)
    expect(store().accounts.get('comprador-1')).toMatchObject({ balance: 2500 })

    const reversed = await call(
      'post',
      '/api/internal/v1/wallet/buy-now-transfers/buy-now-1/reversals',
      { operationId: 'buy-now-1' },
    )
    expect(reversed.status).toBe(200)
    expect(reversed.body).toMatchObject({ status: 'REVERSED', applied: true })
    expect(store().accounts.get('comprador-1')).toMatchObject({ balance: 5000 })
    expect(store().accounts.get('vendedor-1')).toMatchObject({ balance: 1000 })

    const reverseAgain = await call(
      'post',
      '/api/internal/v1/wallet/buy-now-transfers/buy-now-1/reversals',
      { operationId: 'buy-now-1' },
    )
    expect(reverseAgain.body).toMatchObject({ status: 'REVERSED', applied: false })
    expect(store().accounts.get('comprador-1')).toMatchObject({ balance: 5000 })
  })

  it('rechaza con saldo insuficiente sin mover nada', async () => {
    account('comprador-pobre', 100)
    account('vendedor-2', 0)

    const response = await call('post', '/api/internal/v1/wallet/buy-now-transfers', {
      operationId: 'buy-now-2',
      buyerId: 'comprador-pobre',
      sellerId: 'vendedor-2',
      amount: 500,
    })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('BUY_NOW_TRANSFER_INVALID')
    expect(store().accounts.get('comprador-pobre')).toMatchObject({ balance: 100 })
  })

  it('rechaza revertir una transferencia inexistente', async () => {
    const response = await call(
      'post',
      '/api/internal/v1/wallet/buy-now-transfers/no-existe/reversals',
      { operationId: 'op-x' },
    )

    expect(response.status).toBe(404)
    expect(response.body.code).toBe('BUY_NOW_TRANSFER_NOT_FOUND')
  })

  it('exige la firma HMAC de un llamador autorizado', async () => {
    const response = await call(
      'post',
      '/api/internal/v1/wallet/buy-now-transfers',
      { operationId: 'x', buyerId: 'a', sellerId: 'b', amount: 1 },
      'combat',
    )

    expect(response.status).toBe(401)
  })
})
