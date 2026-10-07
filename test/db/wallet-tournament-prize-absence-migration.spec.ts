import { sql, type Kysely } from 'kysely'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import {
  up,
  down,
} from '../../src/adapters/outbound/persistence/migrations/010-wallet-tournament-prize-absence'
import { PostgresTournamentPrizeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentPrizeRepository'
import { startTestPostgres } from '../support/postgres'
import { qaTournamentPrize } from '../support/tournament-prize'
it('010 conserva recibo/saldo jugado y admite ausencia sin debilitar los demás campos', async () => {
  const server = await startTestPostgres()
  const db = createDatabase({ connectionString: server.connectionString })
  const migrationDb = db as unknown as Kysely<unknown>
  try {
    const old = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '010'))
    expect((await migrateToLatest(db, old)).error).toBeUndefined()
    const command = qaTournamentPrize('upgrade-absence')
    const repository = new PostgresTournamentPrizeRepository(db)
    const receipt = await repository.credit(command, new Date())
    const ledger = await db.selectFrom('wallet_tournament_prize_ledger').selectAll().execute()
    expect(await migrateToLatest(db)).toEqual({
      applied: ['010-wallet-tournament-prize-absence'],
      error: undefined,
    })
    expect(await db.selectFrom('wallet_tournament_prize_ledger').selectAll().execute()).toEqual(
      ledger,
    )
    expect(await repository.credit(command, new Date())).toEqual(receipt)
    await down(migrationDb)
    await up(migrationDb)
    const absent = { ...command, operationId: command.operationId + ':absence', finalRoomId: null }
    expect(await repository.credit(absent, new Date())).toMatchObject({
      ...absent,
      status: 'DELIVERED',
    })
    await expect(down(migrationDb)).rejects.toMatchObject({ code: '23502' })
    const total = await sql<{
      balance: string
    }>`select balance from wallet_accounts where player_id=${command.playerId}`.execute(db)
    expect(total.rows[0]!.balance).toBe('1002')
  } finally {
    await db.destroy()
    await server.stop()
  }
})
