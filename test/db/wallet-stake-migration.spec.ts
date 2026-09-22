import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { up, down } from '../../src/adapters/outbound/persistence/migrations/002-wallet-stakes'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * PostgreSQL REAL (Testcontainers). Lo que se prueba aqui no se puede probar
 * con el doble en memoria: los CHECK constraints, la unicidad
 * `(operation_id, player_id)` del ledger y que `down` deshace `up` sin dejar
 * rastro.
 */
describe('Migracion 002-wallet-stakes', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seedAccount = async (playerId: string, balance = 100): Promise<void> => {
    await sql`insert into wallet_accounts (player_id, balance, reserved, week_identity)
              values (${playerId}, ${balance}, 0, '2026-09-21')`.execute(db)
  }

  const seedHold = async (
    operationId: string,
    playerId: string,
    amount = 10,
    status = 'ACTIVE',
  ): Promise<void> => {
    await sql`insert into wallet_stake_holds
              (operation_id, player_id, battle_id, amount, status, expires_at)
              values (${operationId}, ${playerId}, 'battle-1', ${amount}, ${status}, now() + interval '24 hours')`.execute(
      db,
    )
  }

  it('crea las dos tablas y anade reserved a wallet_accounts', async () => {
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'wallet%'`.execute(db)
    const names = tables.rows.map((row) => row.table_name)

    expect(names).toEqual(
      expect.arrayContaining(['wallet_stake_holds', 'wallet_stake_ledger', 'wallet_accounts']),
    )

    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_name = 'wallet_accounts'`.execute(db)
    expect(columns.rows.map((row) => row.column_name)).toContain('reserved')
  })

  it('rechaza reserved negativo (check reserved >= 0)', async () => {
    await seedAccount('player-mig-reserved-neg')

    await expect(
      sql`update wallet_accounts set reserved = -1 where player_id = 'player-mig-reserved-neg'`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('rechaza reserved por encima del balance (check reserved <= balance)', async () => {
    await seedAccount('player-mig-reserved-over', 50)

    await expect(
      sql`update wallet_accounts set reserved = 51 where player_id = 'player-mig-reserved-over'`.execute(
        db,
      ),
    ).rejects.toThrow()

    // El limite exacto si es valido.
    await sql`update wallet_accounts set reserved = 50 where player_id = 'player-mig-reserved-over'`.execute(
      db,
    )
  })

  it('rechaza un hold con amount <= 0 o con un status desconocido', async () => {
    await seedAccount('player-mig-hold')

    await expect(seedHold('hold-mig-zero', 'player-mig-hold', 0)).rejects.toThrow()
    await expect(seedHold('hold-mig-neg', 'player-mig-hold', -5)).rejects.toThrow()
    await expect(seedHold('hold-mig-status', 'player-mig-hold', 10, 'RARA')).rejects.toThrow()
  })

  it('rechaza un kind desconocido en el ledger', async () => {
    await seedAccount('player-mig-ledger')
    await seedHold('hold-mig-ledger', 'player-mig-ledger')

    await expect(
      sql`insert into wallet_stake_ledger
          (operation_id, kind, hold_operation_id, player_id, battle_id, amount, resulting_balance, resulting_reserved)
          values ('op-mig-ledger', 'RARO', 'hold-mig-ledger', 'player-mig-ledger', 'battle-1', 10, 100, 10)`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('rechaza dos movimientos del mismo (operation_id, player_id): el replay se relee, no se reinserta', async () => {
    await seedAccount('player-mig-dup')
    await seedHold('hold-mig-dup', 'player-mig-dup')

    const insert = (): Promise<unknown> =>
      sql`insert into wallet_stake_ledger
          (operation_id, kind, hold_operation_id, player_id, battle_id, amount, resulting_balance, resulting_reserved)
          values ('op-mig-dup', 'RESERVE', 'hold-mig-dup', 'player-mig-dup', 'battle-1', 10, 100, 10)`.execute(
        db,
      )

    await insert()
    await expect(insert()).rejects.toThrow()

    // Pero el MISMO operation_id con OTRO jugador si convive: es el caso de
    // `/settle`, una operacion por batalla con N movimientos.
    await seedAccount('player-mig-dup-2')
    await seedHold('hold-mig-dup-2', 'player-mig-dup-2')
    await sql`insert into wallet_stake_ledger
              (operation_id, kind, hold_operation_id, player_id, battle_id, amount, resulting_balance, resulting_reserved)
              values ('op-mig-dup', 'SETTLE_CREDIT', 'hold-mig-dup-2', 'player-mig-dup-2', 'battle-1', 10, 110, 0)`.execute(
      db,
    )
  })

  it('down elimina las tablas y la columna sin dejar rastro', async () => {
    // La migracion declara `Kysely<unknown>` (convencion de 001): solo usa
    // operaciones de esquema, que no dependen de los tipos de las tablas.
    const migrationDb = db as unknown as Kysely<unknown>
    await down(migrationDb)

    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables
      where table_schema = 'public'`.execute(db)
    const names = tables.rows.map((row) => row.table_name)
    expect(names).not.toContain('wallet_stake_holds')
    expect(names).not.toContain('wallet_stake_ledger')

    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_name = 'wallet_accounts'`.execute(db)
    expect(columns.rows.map((row) => row.column_name)).not.toContain('reserved')

    // `up` de nuevo: la migracion es reversible de verdad.
    await up(migrationDb)
    const recreated = await sql<{ table_name: string }>`select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'wallet_stake_holds'`.execute(db)
    expect(recreated.rows).toHaveLength(1)
  })
})
