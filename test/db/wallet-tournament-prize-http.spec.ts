import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { type Kysely } from 'kysely'
import request from 'supertest'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import {
  TOURNAMENT_PRIZE_REPOSITORY,
  type TournamentPrizeRepositoryPort,
} from '../../src/application/ports/TournamentPrizeRepositoryPort'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { qaTournamentPrize } from '../support/tournament-prize'
import { startTestPostgres } from '../support/postgres'

describe('HTTP HU-86 + PostgreSQL: commit, timeout y reinicio', () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let app: INestApplication
  const secret = 'qa-hu86-http-postgres-only'
  const path = '/api/internal/v1/wallet/credits/tournament-prize'
  const headers = (body: unknown) => {
    const timestamp = String(Date.now())
    return {
      'content-type': 'application/json',
      'x-internal-service': 'tournament',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signInternalRequest(secret, {
        service: 'tournament',
        method: 'POST',
        path,
        timestamp,
        body,
      }),
    }
  }
  const boot = async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(
        loadConfig({
          NODE_ENV: 'test',
          AUTH_MODE: 'jwt',
          COGNITO_USER_POOL_ID: 'us-east-1_qa',
          COGNITO_CLIENT_ID: 'qa-client',
          PERSISTENCE_DRIVER: 'postgres',
          DATABASE_URL: postgres.connectionString,
          INTERNAL_SERVICE_AUTH_SECRET: secret,
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
    await instance.listen(0, '127.0.0.1')
    return instance
  }
  const call = (input: unknown) =>
    request(app.getHttpServer())
      .post(path)
      .set(headers(input))
      .send(input as object)
  beforeAll(async () => {
    postgres = await startTestPostgres()
    db = createDatabase({ connectionString: postgres.connectionString })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    app = await boot()
  })
  afterAll(async () => {
    await app.close()
    await db.destroy()
    await postgres.stop()
  })
  it('dos solicitudes HTTP simultáneas recuperan exactamente el mismo recibo', async () => {
    const c = qaTournamentPrize('http-concurrent')
    const results = await Promise.all([call(c), call(c)])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(results[0].body).toEqual(results[1].body)
    expect(results[0].body).toEqual({ ...c, status: 'DELIVERED', receiptId: expect.any(String) })
    expect(
      (
        await db
          .selectFrom('wallet_accounts')
          .select('balance')
          .where('player_id', '=', c.playerId)
          .executeTakeFirstOrThrow()
      ).balance,
    ).toBe(c.amount)
  })
  it('el socket pierde respuesta después del commit; al reiniciar Wallet y su pool, replay recupera el recibo', async () => {
    const c = qaTournamentPrize('http-timeout')
    const repository = app.get<TournamentPrizeRepositoryPort>(TOURNAMENT_PRIZE_REPOSITORY)
    const original = repository.credit.bind(repository)
    let commitReached!: () => void
    let resumeResponse!: () => void
    const committed = new Promise<void>((resolve) => {
      commitReached = resolve
    })
    const release = new Promise<void>((resolve) => {
      resumeResponse = resolve
    })
    jest.spyOn(repository, 'credit').mockImplementationOnce(async (command, now) => {
      const receipt = await original(command, now)
      commitReached()
      await release
      return receipt
    })
    const abort = new AbortController()
    const uncertain = fetch(`${await app.getUrl()}${path}`, {
      method: 'POST',
      headers: headers(c),
      body: JSON.stringify(c),
      signal: abort.signal,
    }).then(
      () => 'unexpected-response',
      (error: unknown) => error,
    )
    await committed
    const stored = await db
      .selectFrom('wallet_tournament_prize_ledger')
      .select(['receipt_id', 'resulting_balance'])
      .where('operation_id', '=', c.operationId)
      .executeTakeFirstOrThrow()
    abort.abort(new Error('QA timeout después del commit'))
    resumeResponse()
    expect(await uncertain).toBeInstanceOf(Error)
    await app.close()
    await db.destroy()
    db = createDatabase({ connectionString: postgres.connectionString })
    app = await boot()
    const replay = await call(c)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ ...c, status: 'DELIVERED', receiptId: stored.receipt_id })
    expect(stored.resulting_balance).toBe('501')
    expect(
      await db
        .selectFrom('wallet_tournament_prize_ledger')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .execute(),
    ).toHaveLength(1)
    const conflict = await call({ ...c, amount: '502' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('OPERATION_ID_REUSED')
  })
})
