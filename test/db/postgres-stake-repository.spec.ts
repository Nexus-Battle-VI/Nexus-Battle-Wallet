import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  HoldAmountMismatchError,
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
  SettlementNotZeroSumError,
} from '../../src/application/errors/StakePersistenceError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresStakeRepository } from '../../src/adapters/outbound/persistence/PostgresStakeRepository'
import { PostgresWalletRepository } from '../../src/adapters/outbound/persistence/PostgresWalletRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * PostgreSQL REAL (Testcontainers). Aqui se prueba lo que el doble en memoria
 * no puede: los CHECK constraints, la unicidad del ledger y, sobre todo, que
 * dos operaciones CONCURRENTES sobre la misma cuenta no puedan reservar dos
 * veces el mismo disponible (`pg_advisory_xact_lock`).
 */
describe('PostgresStakeRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let stakes: PostgresStakeRepository
  let wallet: PostgresWalletRepository

  const AT = new Date('2026-09-22T15:00:00.000Z')
  const TTL_MS = 24 * 60 * 60 * 1000

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    stakes = new PostgresStakeRepository(db)
    wallet = new PostgresWalletRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seedAccount = async (playerId: string, balance: number): Promise<void> => {
    await sql`insert into wallet_accounts (player_id, balance, reserved, week_identity)
              values (${playerId}, ${balance}, 0, '2026-09-21')`.execute(db)
  }

  const holdIdOf = (playerId: string, battleId: string): string =>
    `battle:${battleId}:player:${playerId}:stake:reserve`

  const reserve = (playerId: string, amount: number, battleId: string, clockNow: Date = AT) =>
    stakes.reserve(
      {
        operationId: holdIdOf(playerId, battleId),
        playerId,
        battleId,
        amount,
        occurredAt: clockNow,
      },
      clockNow,
    )

  const release = (playerId: string, battleId: string, suffix = '') =>
    stakes.release({
      operationId: `battle:${battleId}:player:${playerId}:stake:release${suffix}`,
      holdId: holdIdOf(playerId, battleId),
      reason: 'ROOM_CANCELLED',
    })

  const accountRow = async (playerId: string) => {
    const result = await sql<{ balance: string; reserved: string }>`select balance, reserved
      from wallet_accounts where player_id = ${playerId}`.execute(db)

    return result.rows[0]
  }

  it('reserva: `reserved` sube, `balance` NO cambia y el hold vence a 24 h', async () => {
    const player = 'stake-pg-reserve'
    await seedAccount(player, 100)

    const result = await reserve(player, 30, 'room-1')

    expect(result).toEqual({
      operationId: holdIdOf(player, 'room-1'),
      applied: true,
      holdId: holdIdOf(player, 'room-1'),
      balance: 100,
      reserved: 30,
      available: 70,
    })

    const hold = await sql<{
      amount: string
      status: string
      expires_at: Date
    }>`select amount, status, expires_at
      from wallet_stake_holds where operation_id = ${holdIdOf(player, 'room-1')}`.execute(db)
    expect(hold.rows[0]).toMatchObject({ amount: '30', status: 'ACTIVE' })
    expect(hold.rows[0]?.expires_at.getTime()).toBe(AT.getTime() + TTL_MS)

    const snapshot = await wallet.getSnapshot(player, '2026-09-21')
    expect(snapshot).toMatchObject({ balance: 100, reserved: 30, available: 70 })
  })

  it('disponible insuficiente: NADA queda escrito', async () => {
    const player = 'stake-pg-insufficient'
    await seedAccount(player, 10)

    await expect(reserve(player, 11, 'room-1')).rejects.toThrow(InsufficientAvailableBalanceError)

    expect(await accountRow(player)).toMatchObject({ balance: '10', reserved: '0' })
    const holds = await sql`select 1 from wallet_stake_holds where player_id = ${player}`.execute(
      db,
    )
    const ledger = await sql`select 1 from wallet_stake_ledger where player_id = ${player}`.execute(
      db,
    )
    expect(holds.rows).toHaveLength(0)
    expect(ledger.rows).toHaveLength(0)
  })

  it('replay: mismo operationId y mismo cuerpo devuelve el resultado original', async () => {
    const player = 'stake-pg-replay'
    await seedAccount(player, 100)

    const first = await reserve(player, 10, 'room-1')
    const replay = await reserve(player, 10, 'room-1')

    expect(replay).toEqual({ ...first, applied: false })
    const holds = await sql`select 1 from wallet_stake_holds where player_id = ${player}`.execute(
      db,
    )
    expect(holds.rows).toHaveLength(1)
  })

  it('conflicto: mismo operationId con otro monto responde OperationConflictError', async () => {
    const player = 'stake-pg-conflict'
    await seedAccount(player, 100)

    await reserve(player, 10, 'room-1')

    await expect(reserve(player, 20, 'room-1')).rejects.toThrow(OperationConflictError)
  })

  it('dos reservas CONCURRENTES del mismo jugador que juntas exceden el disponible: una pasa, una falla (S-14)', async () => {
    const player = 'stake-pg-concurrent'
    await seedAccount(player, 100)

    const results = await Promise.allSettled([
      reserve(player, 60, 'room-a'),
      reserve(player, 60, 'room-b'),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBeInstanceOf(InsufficientAvailableBalanceError)

    expect(await accountRow(player)).toMatchObject({ reserved: '60' })
    const holds = await sql`select 1 from wallet_stake_holds where player_id = ${player}`.execute(
      db,
    )
    expect(holds.rows).toHaveLength(1)
  })

  it('libera: `reserved` baja, `balance` NO cambia y el hold queda RELEASED', async () => {
    const player = 'stake-pg-release'
    await seedAccount(player, 100)
    await reserve(player, 25, 'room-1')

    const result = await release(player, 'room-1')

    expect(result).toMatchObject({ applied: true, balance: 100, reserved: 0, available: 100 })
    expect(await accountRow(player)).toMatchObject({ balance: '100', reserved: '0' })

    const hold = await sql<{ status: string }>`select status from wallet_stake_holds
      where operation_id = ${holdIdOf(player, 'room-1')}`.execute(db)
    expect(hold.rows[0]?.status).toBe('RELEASED')
  })

  it('liberar un hold ya liberado con OTRA operacion no vuelve a tocar `reserved`', async () => {
    const player = 'stake-pg-release-twice'
    await seedAccount(player, 100)
    await reserve(player, 25, 'room-1')

    await release(player, 'room-1')
    const second = await release(player, 'room-1', ':2')

    expect(second).toMatchObject({ applied: false, reserved: 0 })
    expect(await accountRow(player)).toMatchObject({ reserved: '0' })
  })

  it('dos liberaciones CONCURRENTES del mismo hold: solo una aplica', async () => {
    const player = 'stake-pg-release-race'
    await seedAccount(player, 100)
    await reserve(player, 25, 'room-1')

    const results = await Promise.all([release(player, 'room-1'), release(player, 'room-1', ':2')])

    expect(results.filter((result) => result.applied)).toHaveLength(1)
    expect(await accountRow(player)).toMatchObject({ reserved: '0' })
  })

  it('liberar un hold inexistente responde HoldNotFoundError', async () => {
    await expect(
      stakes.release({
        operationId: 'battle:room-x:player:nadie:stake:release',
        holdId: 'battle:room-x:player:nadie:stake:reserve',
        reason: 'PARTICIPANT_LEFT',
      }),
    ).rejects.toThrow(HoldNotFoundError)
  })

  it('1v1: el perdedor baja y el ganador sube EXACTAMENTE lo mismo; ambos `reserved` a 0 (S-07)', async () => {
    await seedAccount('stake-pg-loser', 100)
    await seedAccount('stake-pg-winner', 100)
    await reserve('stake-pg-loser', 10, 'room-1v1')
    await reserve('stake-pg-winner', 10, 'room-1v1')

    const result = await stakes.settle({
      operationId: 'battle:room-1v1:stakes:settle',
      battleId: 'room-1v1',
      settlements: [
        {
          playerId: 'stake-pg-loser',
          holdId: holdIdOf('stake-pg-loser', 'room-1v1'),
          outcome: 'CAPTURED',
          amount: 10,
        },
        {
          playerId: 'stake-pg-winner',
          holdId: holdIdOf('stake-pg-winner', 'room-1v1'),
          outcome: 'CREDITED',
          amount: 10,
        },
      ],
    })

    expect(result.applied).toBe(true)
    expect(await accountRow('stake-pg-loser')).toMatchObject({ balance: '90', reserved: '0' })
    expect(await accountRow('stake-pg-winner')).toMatchObject({ balance: '110', reserved: '0' })
  })

  it('2v2: pozo de 30 repartido 15/15 entre los ganadores con apuesta (S-08)', async () => {
    for (const player of ['pg-l1', 'pg-l2', 'pg-w1', 'pg-w2']) {
      await seedAccount(player, 100)
    }
    await reserve('pg-l1', 10, 'room-2v2')
    await reserve('pg-l2', 20, 'room-2v2')
    await reserve('pg-w1', 5, 'room-2v2')
    await reserve('pg-w2', 5, 'room-2v2')

    await stakes.settle({
      operationId: 'battle:room-2v2:stakes:settle',
      battleId: 'room-2v2',
      settlements: [
        {
          playerId: 'pg-l1',
          holdId: holdIdOf('pg-l1', 'room-2v2'),
          outcome: 'CAPTURED',
          amount: 10,
        },
        {
          playerId: 'pg-l2',
          holdId: holdIdOf('pg-l2', 'room-2v2'),
          outcome: 'CAPTURED',
          amount: 20,
        },
        {
          playerId: 'pg-w1',
          holdId: holdIdOf('pg-w1', 'room-2v2'),
          outcome: 'CREDITED',
          amount: 15,
        },
        {
          playerId: 'pg-w2',
          holdId: holdIdOf('pg-w2', 'room-2v2'),
          outcome: 'CREDITED',
          amount: 15,
        },
      ],
    })

    expect(await accountRow('pg-l1')).toMatchObject({ balance: '90', reserved: '0' })
    expect(await accountRow('pg-l2')).toMatchObject({ balance: '80', reserved: '0' })
    expect(await accountRow('pg-w1')).toMatchObject({ balance: '115', reserved: '0' })
    expect(await accountRow('pg-w2')).toMatchObject({ balance: '115', reserved: '0' })
  })

  it('suma que no cuadra: 422 y NADA se aplica, ni capturas ni creditos parciales (S-15)', async () => {
    await seedAccount('pg-nz-l', 100)
    await seedAccount('pg-nz-w', 100)
    await reserve('pg-nz-l', 10, 'room-nz')
    await reserve('pg-nz-w', 10, 'room-nz')

    await expect(
      stakes.settle({
        operationId: 'battle:room-nz:stakes:settle',
        battleId: 'room-nz',
        settlements: [
          {
            playerId: 'pg-nz-l',
            holdId: holdIdOf('pg-nz-l', 'room-nz'),
            outcome: 'CAPTURED',
            amount: 10,
          },
          {
            playerId: 'pg-nz-w',
            holdId: holdIdOf('pg-nz-w', 'room-nz'),
            outcome: 'CREDITED',
            amount: 8,
          },
        ],
      }),
    ).rejects.toThrow(SettlementNotZeroSumError)

    expect(await accountRow('pg-nz-l')).toMatchObject({ balance: '100', reserved: '10' })
    expect(await accountRow('pg-nz-w')).toMatchObject({ balance: '100', reserved: '10' })
    const holds = await sql<{ status: string }>`select status from wallet_stake_holds
      where player_id in ('pg-nz-l', 'pg-nz-w')`.execute(db)
    expect(holds.rows.map((row) => row.status)).toEqual(['ACTIVE', 'ACTIVE'])
  })

  it('monto de CAPTURED que no coincide con el hold: 422 y nada cambia', async () => {
    await seedAccount('pg-mm-l', 100)
    await seedAccount('pg-mm-w', 100)
    await reserve('pg-mm-l', 10, 'room-mm')
    await reserve('pg-mm-w', 10, 'room-mm')

    await expect(
      stakes.settle({
        operationId: 'battle:room-mm:stakes:settle',
        battleId: 'room-mm',
        settlements: [
          {
            playerId: 'pg-mm-l',
            holdId: holdIdOf('pg-mm-l', 'room-mm'),
            outcome: 'CAPTURED',
            amount: 11,
          },
          {
            playerId: 'pg-mm-w',
            holdId: holdIdOf('pg-mm-w', 'room-mm'),
            outcome: 'CREDITED',
            amount: 11,
          },
        ],
      }),
    ).rejects.toThrow(HoldAmountMismatchError)

    expect(await accountRow('pg-mm-l')).toMatchObject({ balance: '100', reserved: '10' })
    expect(await accountRow('pg-mm-w')).toMatchObject({ balance: '100', reserved: '10' })
  })

  it('replay de settle y conflicto con otro cuerpo', async () => {
    await seedAccount('pg-rs-l', 100)
    await seedAccount('pg-rs-w', 100)
    await reserve('pg-rs-l', 10, 'room-rs')
    await reserve('pg-rs-w', 10, 'room-rs')

    const input = {
      operationId: 'battle:room-rs:stakes:settle',
      battleId: 'room-rs',
      settlements: [
        {
          playerId: 'pg-rs-l',
          holdId: holdIdOf('pg-rs-l', 'room-rs'),
          outcome: 'CAPTURED' as const,
          amount: 10,
        },
        {
          playerId: 'pg-rs-w',
          holdId: holdIdOf('pg-rs-w', 'room-rs'),
          outcome: 'CREDITED' as const,
          amount: 10,
        },
      ],
    }

    const first = await stakes.settle(input)
    const replay = await stakes.settle(input)

    expect(replay).toEqual({ ...first, applied: false })

    await expect(
      stakes.settle({
        ...input,
        settlements: [...input.settlements].reverse(),
      }),
    ).resolves.toMatchObject({ applied: false })

    await expect(
      stakes.settle({
        ...input,
        settlements: [
          {
            playerId: 'pg-rs-w',
            holdId: holdIdOf('pg-rs-w', 'room-rs'),
            outcome: 'CAPTURED',
            amount: 10,
          },
          {
            playerId: 'pg-rs-l',
            holdId: holdIdOf('pg-rs-l', 'room-rs'),
            outcome: 'CREDITED',
            amount: 10,
          },
        ],
      }),
    ).rejects.toThrow(OperationConflictError)
  })

  it('expira un hold vencido y no toca uno vigente (D11)', async () => {
    const now = new Date('2026-09-22T15:00:00.000Z')
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000)

    await seedAccount('pg-exp-old', 100)
    await seedAccount('pg-exp-current', 100)
    await reserve('pg-exp-old', 10, 'room-old', old)
    await reserve('pg-exp-current', 10, 'room-current', now)

    expect(await stakes.expireStale(now, 10)).toBe(1)

    expect(await accountRow('pg-exp-old')).toMatchObject({ balance: '100', reserved: '0' })
    expect(await accountRow('pg-exp-current')).toMatchObject({ balance: '100', reserved: '10' })

    const expiredHold = await sql<{ status: string }>`select status from wallet_stake_holds
      where operation_id = ${holdIdOf('pg-exp-old', 'room-old')}`.execute(db)
    expect(expiredHold.rows[0]?.status).toBe('EXPIRED')

    // Segundo barrido: ya no queda nada por reclamar.
    expect(await stakes.expireStale(now, 10)).toBe(0)
  })
})
