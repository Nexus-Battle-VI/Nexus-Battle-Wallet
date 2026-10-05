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

  /**
   * HU-90 (CA-05): contrato HTTP del release al cancelar una subasta. Auction
   * decide por el codigo HTTP y el `code` del cuerpo, nunca por el mensaje.
   */
  describe('release por cancelacion de subasta (HU-90, CA-05)', () => {
    const releases = (holdId: string) => `/api/internal/v1/wallet/holds/${holdId}/releases`
    const fund = (playerId: string, balance = 100) => {
      store().accounts.set(playerId, {
        balance,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-09-21',
      })
    }
    const hold = async (holdId: string, playerId: string) => {
      fund(playerId)
      const created = await post('/api/internal/v1/wallet/holds', {
        ...reserve(holdId),
        playerId,
        auctionId: `auction-${holdId}`,
        bidId: `bid-${holdId}`,
      })
      expect(created.status).toBe(200)
    }

    it('ACTIVE + AUCTION_CANCELLED libera con applied=true y deja reserved en cero', async () => {
      await hold('cancel-active', 'cancel-active-buyer')
      expect(store().accounts.get('cancel-active-buyer')).toMatchObject({ reserved: 30 })

      const released = await post(releases('cancel-active'), {
        operationId: 'cancel-active-release',
        reason: 'AUCTION_CANCELLED',
      })

      expect(released.status).toBe(200)
      expect(released.body).toEqual({
        operationId: 'cancel-active-release',
        holdId: 'cancel-active',
        holdStatus: 'RELEASED',
        applied: true,
      })
      expect(store().accounts.get('cancel-active-buyer')).toMatchObject({
        balance: 100,
        reserved: 0,
      })
    })

    it('el replay del mismo operationId responde 200 con applied=false sin liberar dos veces', async () => {
      await hold('cancel-replay', 'cancel-replay-buyer')
      const body = { operationId: 'cancel-replay-release', reason: 'AUCTION_CANCELLED' }
      await post(releases('cancel-replay'), body)

      const replay = await post(releases('cancel-replay'), body)

      expect(replay.status).toBe(200)
      expect(replay.body).toMatchObject({ holdStatus: 'RELEASED', applied: false })
      expect(store().accounts.get('cancel-replay-buyer')).toMatchObject({
        balance: 100,
        reserved: 0,
      })
    })

    it('un hold ya RELEASED por otra operacion responde 200 no-op', async () => {
      await hold('cancel-released', 'cancel-released-buyer')
      await post(releases('cancel-released'), {
        operationId: 'outbid-first',
        reason: 'AUCTION_OUTBID',
      })

      const again = await post(releases('cancel-released'), {
        operationId: 'cancel-after-outbid',
        reason: 'AUCTION_CANCELLED',
      })

      expect(again.status).toBe(200)
      expect(again.body).toEqual({
        operationId: 'cancel-after-outbid',
        holdId: 'cancel-released',
        holdStatus: 'RELEASED',
        applied: false,
      })
      expect(store().accounts.get('cancel-released-buyer')).toMatchObject({
        balance: 100,
        reserved: 0,
      })
    })

    it('un hold EXPIRED responde 200 no-op con su estado real', async () => {
      await hold('cancel-expired', 'cancel-expired-buyer')
      const stored = store().auctionHolds.get('cancel-expired')
      if (stored === undefined) throw new Error('El hold de prueba no existe.')
      // Mismo efecto que el job de expiracion: baja reserved y marca EXPIRED.
      stored.status = 'EXPIRED'
      const account = store().accounts.get('cancel-expired-buyer')
      if (account === undefined) throw new Error('La cuenta de prueba no existe.')
      account.reserved -= stored.amount

      const released = await post(releases('cancel-expired'), {
        operationId: 'cancel-expired-release',
        reason: 'AUCTION_CANCELLED',
      })

      expect(released.status).toBe(200)
      expect(released.body).toEqual({
        operationId: 'cancel-expired-release',
        holdId: 'cancel-expired',
        holdStatus: 'EXPIRED',
        applied: false,
      })
      expect(store().accounts.get('cancel-expired-buyer')).toMatchObject({
        balance: 100,
        reserved: 0,
      })
    })

    it('un hold CAPTURED responde 422 AUCTION_HOLD_ALREADY_CAPTURED, nunca 200', async () => {
      await hold('cancel-captured', 'cancel-captured-buyer')
      fund('cancel-captured-seller', 0)
      const captured = await post('/api/internal/v1/wallet/holds/cancel-captured/captures', {
        operationId: 'cancel-captured-capture',
        beneficiaryPlayerId: 'cancel-captured-seller',
        auctionId: 'auction-cancel-captured',
        winningBidId: 'bid-cancel-captured',
      })
      expect(captured.status).toBe(200)

      const released = await post(releases('cancel-captured'), {
        operationId: 'cancel-captured-release',
        reason: 'AUCTION_CANCELLED',
      })

      expect(released.status).toBe(422)
      expect(released.body).toMatchObject({
        statusCode: 422,
        code: 'AUCTION_HOLD_ALREADY_CAPTURED',
      })
      expect(released.body.applied).toBeUndefined()
      expect(store().accounts.get('cancel-captured-buyer')).toMatchObject({
        balance: 70,
        reserved: 0,
      })
      expect(store().accounts.get('cancel-captured-seller')).toMatchObject({ balance: 30 })
    })

    it('un hold inexistente responde 404 HOLD_NOT_FOUND', async () => {
      const released = await post(releases('cancel-missing'), {
        operationId: 'cancel-missing-release',
        reason: 'AUCTION_CANCELLED',
      })

      expect(released.status).toBe(404)
      expect(released.body).toMatchObject({ code: 'HOLD_NOT_FOUND' })
    })

    it('el mismo operationId con otro reason responde 409 OPERATION_CONFLICT', async () => {
      await hold('cancel-conflict', 'cancel-conflict-buyer')
      const first = await post(releases('cancel-conflict'), {
        operationId: 'cancel-conflict-release',
        reason: 'AUCTION_SETTLEMENT_LOST',
      })
      expect(first.status).toBe(200)

      const conflict = await post(releases('cancel-conflict'), {
        operationId: 'cancel-conflict-release',
        reason: 'AUCTION_CANCELLED',
      })

      expect(conflict.status).toBe(409)
      expect(conflict.body).toMatchObject({ code: 'OPERATION_CONFLICT' })
    })

    it.each(['AUCTION_OUTBID', 'AUCTION_SETTLEMENT_LOST'])(
      'el motivo existente %s sigue liberando un hold ACTIVE',
      async (reason) => {
        const holdId = `legacy-${reason.toLowerCase()}`
        await hold(holdId, `${holdId}-buyer`)

        const released = await post(releases(holdId), { operationId: `${holdId}-release`, reason })

        expect(released.status).toBe(200)
        expect(released.body).toMatchObject({ holdStatus: 'RELEASED', applied: true })
        expect(store().accounts.get(`${holdId}-buyer`)).toMatchObject({ balance: 100, reserved: 0 })
      },
    )

    it('rechaza con 400 un reason fuera del contrato', async () => {
      await hold('cancel-bad-reason', 'cancel-bad-reason-buyer')

      const released = await post(releases('cancel-bad-reason'), {
        operationId: 'cancel-bad-reason-release',
        reason: 'AUCTION_WHATEVER',
      })

      expect(released.status).toBe(400)
      expect(store().accounts.get('cancel-bad-reason-buyer')).toMatchObject({ reserved: 30 })
    })
  })
})
