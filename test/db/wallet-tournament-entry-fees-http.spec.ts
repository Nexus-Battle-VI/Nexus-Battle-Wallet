import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'
import { startTestPostgres } from '../support/postgres'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  TOURNAMENT_ENTRY_FEE_REPOSITORY,
  type TournamentEntryFeeRepositoryPort,
} from '../../src/application/ports/TournamentEntryFeeRepositoryPort'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('HTTP Wallet + PostgreSQL: recuperación tras perder respuesta y reiniciar', () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let app: INestApplication
  const secret = 'test-wallet-tournament-durable-hmac'
  const path = '/api/internal/v1/wallet/tournament-entry-fees'
  const input = {
    operationId: 'entry:durable-team:payment:charge',
    payerId: 'durable-payer',
    tournamentId: 'durable-tournament',
    teamId: 'durable-team',
    amount: 100,
  }

  const boot = async (): Promise<INestApplication> => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_test',
      COGNITO_CLIENT_ID: 'test-client',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: postgres.connectionString,
      INTERNAL_SERVICE_AUTH_SECRET: secret,
      STAKE_EXPIRY_INTERVAL_MS: '0',
      LOG_LEVEL: 'error',
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile()
    const instance = module.createNestApplication()
    instance.setGlobalPrefix('api')
    instance.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await instance.init()
    return instance
  }
  const call = (route: string, body: Record<string, unknown>) => {
    const timestamp = String(Date.now())
    const signature = signInternalRequest(secret, {
      service: 'tournament',
      method: 'POST',
      path: route,
      timestamp,
      body,
    })
    return request(app.getHttpServer())
      .post(route)
      .set('x-internal-service', 'tournament')
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
      .send(body)
  }
  const balance = async (payerId: string): Promise<string> =>
    (
      await db
        .selectFrom('wallet_accounts')
        .select('balance')
        .where('player_id', '=', payerId)
        .executeTakeFirstOrThrow()
    ).balance

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

  it('conserva un cobro y una devolución después de dos respuestas 503 y dos arranques nuevos', async () => {
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${input.payerId},120.5,20,'2026-W41')`.execute(
      db,
    )
    const repository = app.get<TournamentEntryFeeRepositoryPort>(TOURNAMENT_ENTRY_FEE_REPOSITORY)
    const charge = repository.charge.bind(repository)
    jest.spyOn(repository, 'charge').mockImplementationOnce(async (command) => {
      await charge(command)
      throw new Error('Respuesta de débito perdida después del commit (prueba)')
    })
    const uncertainCharge = await call(path, input)
    expect(uncertainCharge.status).toBe(503)
    expect(uncertainCharge.body.code).toBe('DEPENDENCY_UNAVAILABLE')
    expect(await balance(input.payerId)).toBe('20.5')
    await app.close()
    app = await boot()
    const recovered = await call(path, input)
    expect(recovered.status).toBe(200)
    expect(recovered.body).toEqual({
      ...input,
      chargeId: input.operationId,
      status: 'CHARGED',
      applied: false,
    })
    expect(await balance(input.payerId)).toBe('20.5')

    const refundRepository = app.get<TournamentEntryFeeRepositoryPort>(
      TOURNAMENT_ENTRY_FEE_REPOSITORY,
    )
    const refund = refundRepository.refund.bind(refundRepository)
    jest.spyOn(refundRepository, 'refund').mockImplementationOnce(async (command) => {
      await refund(command)
      throw new Error('Respuesta de compensación perdida después del commit (prueba)')
    })
    const refundPath = `${path}/${input.operationId}/refunds`
    const refundOperationId = 'entry:durable-team:payment:refund'
    expect((await call(refundPath, { operationId: refundOperationId })).status).toBe(503)
    expect(await balance(input.payerId)).toBe('120.5')
    await app.close()
    app = await boot()
    const recoveredRefund = await call(refundPath, { operationId: refundOperationId })
    expect(recoveredRefund.status).toBe(200)
    expect(recoveredRefund.body).toEqual({
      ...input,
      operationId: refundOperationId,
      chargeId: input.operationId,
      status: 'REFUNDED',
      applied: false,
    })
    const oldCharge = await call(path, input)
    expect(oldCharge.body).toEqual({
      ...input,
      chargeId: input.operationId,
      status: 'REFUNDED',
      applied: false,
    })
    expect(await balance(input.payerId)).toBe('120.5')
    const ledger = await db
      .selectFrom('wallet_tournament_entry_ledger')
      .select(['kind', 'amount', 'resulting_balance'])
      .where('charge_id', '=', input.operationId)
      .orderBy('kind')
      .execute()
    expect(ledger).toEqual([
      { kind: 'CHARGE', amount: '100', resulting_balance: '20.5' },
      { kind: 'REFUND', amount: '100', resulting_balance: '120.5' },
    ])
  })

  it('el rechazo 99/100 sigue rechazado tras recarga y nuevo arranque; otra operación sí cobra', async () => {
    const rejected = { ...input, operationId: 'entry:rejected:charge', payerId: 'rejected-payer' }
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${rejected.payerId},99,0,'2026-W41')`.execute(
      db,
    )
    const first = await call(path, rejected)
    expect(first.status).toBe(422)
    expect(first.body.code).toBe('INSUFFICIENT_BALANCE')
    expect(await balance(rejected.payerId)).toBe('99')
    await sql`update wallet_accounts set balance=120 where player_id=${rejected.payerId}`.execute(
      db,
    )
    await app.close()
    app = await boot()
    expect((await call(path, rejected)).status).toBe(422)
    expect(await balance(rejected.payerId)).toBe('120')
    expect(
      await db
        .selectFrom('wallet_tournament_entry_ledger')
        .selectAll()
        .where('charge_id', '=', rejected.operationId)
        .execute(),
    ).toHaveLength(0)
    const next = await call(path, { ...rejected, operationId: 'entry:new-attempt:charge' })
    expect(next.status).toBe(200)
    expect(await balance(rejected.payerId)).toBe('20')
  })
})
