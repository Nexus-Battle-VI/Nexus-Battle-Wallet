import { sql, type Kysely } from 'kysely'
import { PostgresTournamentPrizeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentPrizeRepository'
import { PostgresTournamentEntryFeeRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEntryFeeRepository'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { startTestPostgres } from '../support/postgres'
import { qaTournamentPrize } from '../support/tournament-prize'

describe('Premio HU-86 en PostgreSQL real, dos pools', () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let second: Kysely<Database>
  let prizes: PostgresTournamentPrizeRepository
  const now = new Date('2026-10-05T19:00:00Z')
  beforeAll(async () => {
    postgres = await startTestPostgres()
    db = createDatabase({ connectionString: postgres.connectionString })
    second = createDatabase({ connectionString: postgres.connectionString })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    prizes = new PostgresTournamentPrizeRepository(db)
  })
  afterAll(async () => {
    await second.destroy()
    await db.destroy()
    await postgres.stop()
  })
  const account = (player: string) =>
    db
      .selectFrom('wallet_accounts')
      .selectAll()
      .where('player_id', '=', player)
      .executeTakeFirstOrThrow()
  it('suma el máximo exactamente a un saldo grande con fracción; mantiene reservas, cofres y semana', async () => {
    const c = { ...qaTournamentPrize('exact'), amount: '9007199254740991' }
    await sql`insert into wallet_accounts (player_id,balance,reserved,victory_progress,weekly_chest_count,week_identity)
      values (${c.playerId},9007199254740991.5,20,7,2,'2026-W40')`.execute(db)
    const result = await prizes.credit(c, now)
    expect(result).toEqual({ ...c, status: 'DELIVERED', receiptId: expect.any(String) })
    expect(await account(c.playerId)).toMatchObject({
      balance: '18014398509481982.5',
      reserved: '20',
      victory_progress: 7,
      weekly_chest_count: 2,
      week_identity: '2026-W40',
    })
    expect(
      await db
        .selectFrom('wallet_tournament_prize_ledger')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      receipt_id: result.receiptId,
      amount: c.amount,
      resulting_balance: '18014398509481982.5',
      tournament_id: c.tournamentId,
      champion_team_id: c.championTeamId,
      final_encounter_id: c.finalEncounterId,
      final_room_id: c.finalRoomId,
      player_id: c.playerId,
      hero_id: c.heroId,
    })
    await expect(
      db
        .updateTable('wallet_tournament_prize_ledger')
        .set({ receipt_id: '00000000-0000-0000-0000-000000000000' })
        .where('operation_id', '=', c.operationId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('dos pools y replay después de recrear pool conservan un abono y el mismo recibo/saldo aplicado', async () => {
    const c = qaTournamentPrize('concurrent')
    const results = await Promise.all([
      prizes.credit(c, now),
      new PostgresTournamentPrizeRepository(second).credit(c, new Date()),
    ])
    expect(results[0]).toEqual(results[1])
    expect((await account(c.playerId)).balance).toBe('501')
    expect(
      await db
        .selectFrom('wallet_tournament_prize_ledger')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .execute(),
    ).toHaveLength(1)
    await second.destroy()
    second = createDatabase({ connectionString: postgres.connectionString })
    // Otro derecho cambia el saldo actual; el replay mantiene su recibo y saldo histórico.
    await prizes.credit({ ...c, operationId: `${c.operationId}:other` }, now)
    expect(await new PostgresTournamentPrizeRepository(second).credit(c, new Date())).toEqual(
      results[0],
    )
    expect((await account(c.playerId)).balance).toBe('1002')
    expect(
      (
        await db
          .selectFrom('wallet_tournament_prize_ledger')
          .select('resulting_balance')
          .where('operation_id', '=', c.operationId)
          .executeTakeFirstOrThrow()
      ).resulting_balance,
    ).toBe('501')
  })
  it.each([
    'amount',
    'playerId',
    'heroId',
    'tournamentId',
    'championTeamId',
    'finalEncounterId',
    'finalRoomId',
  ] as const)('mismo id con otro %s produce conflicto sin abonar', async (field) => {
    const c = qaTournamentPrize(`conflict-${field}`)
    await prizes.credit(c, now)
    await expect(
      prizes.credit({ ...c, [field]: field === 'amount' ? '502' : `qa-other-${field}` }, now),
    ).rejects.toBeInstanceOf(OperationConflictError)
    expect((await account(c.playerId)).balance).toBe('501')
    expect(
      await db
        .selectFrom('wallet_tournament_prize_ledger')
        .select('operation_id')
        .where('operation_id', '=', c.operationId)
        .execute(),
    ).toHaveLength(1)
  })
  it('fallo de ledger después del UPDATE revierte saldo, cuenta nueva, reserva de id y recibo', async () => {
    const c = qaTournamentPrize('rollback')
    await sql`create function qa_fail_prize() returns trigger language plpgsql as $$ begin
      if new.operation_id='qa:wallet:prize:rollback' then raise exception 'qa injected ledger failure'; end if; return new; end $$`.execute(
      db,
    )
    await sql`create trigger qa_fail_prize before insert on wallet_tournament_prize_ledger for each row execute function qa_fail_prize()`.execute(
      db,
    )
    try {
      await expect(prizes.credit(c, now)).rejects.toThrow('qa injected ledger failure')
      expect(
        await db
          .selectFrom('wallet_accounts')
          .selectAll()
          .where('player_id', '=', c.playerId)
          .execute(),
      ).toHaveLength(0)
      expect(
        await db
          .selectFrom('wallet_tournament_operation_ids')
          .selectAll()
          .where('operation_id', '=', c.operationId)
          .execute(),
      ).toHaveLength(0)
      expect(
        await db
          .selectFrom('wallet_tournament_prize_ledger')
          .selectAll()
          .where('operation_id', '=', c.operationId)
          .execute(),
      ).toHaveLength(0)
      await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${c.playerId},100.5,20,'2026-W40')`.execute(
        db,
      )
      await expect(prizes.credit(c, now)).rejects.toThrow('qa injected ledger failure')
      expect(await account(c.playerId)).toMatchObject({ balance: '100.5', reserved: '20' })
      expect(
        await db
          .selectFrom('wallet_tournament_operation_ids')
          .selectAll()
          .where('operation_id', '=', c.operationId)
          .execute(),
      ).toHaveLength(0)
    } finally {
      await sql`drop trigger qa_fail_prize on wallet_tournament_prize_ledger`.execute(db)
      await sql`drop function qa_fail_prize()`.execute(db)
    }
    expect((await prizes.credit(c, now)).status).toBe('DELIVERED')
  })
  it('colisiones premio/cobro/devolución en ambos sentidos; HU-84 conserva medios créditos', async () => {
    const c = qaTournamentPrize('fees')
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${c.playerId},1000.5,20,'2026-W40')`.execute(
      db,
    )
    const fees = new PostgresTournamentEntryFeeRepository(db)
    const charge = {
      operationId: 'qa:fee-before-prize',
      tournamentId: c.tournamentId,
      teamId: c.championTeamId,
      payerId: c.playerId,
      amount: 100,
      now,
    }
    await fees.charge(charge)
    await expect(
      prizes.credit({ ...c, operationId: charge.operationId }, now),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await fees.refund({ operationId: 'qa:refund-before-prize', chargeId: charge.operationId, now })
    await expect(
      prizes.credit({ ...c, operationId: 'qa:refund-before-prize' }, now),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await prizes.credit(c, now)
    await expect(fees.charge({ ...charge, operationId: c.operationId })).rejects.toBeInstanceOf(
      OperationConflictError,
    )
    await expect(
      fees.refund({ operationId: c.operationId, chargeId: charge.operationId, now }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    expect(await account(c.playerId)).toMatchObject({ balance: '1501.5', reserved: '20' })
    expect((await fees.charge(charge)).status).toBe('REFUNDED')
  })
  it('carrera entre abono y fee de otro pool consume el id para un único propósito', async () => {
    const c = qaTournamentPrize('cross-purpose-race')
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${c.playerId},1000.5,0,'2026-W40')`.execute(
      db,
    )
    const outcome = await Promise.allSettled([
      prizes.credit(c, now),
      new PostgresTournamentEntryFeeRepository(second).charge({
        operationId: c.operationId,
        tournamentId: c.tournamentId,
        teamId: c.championTeamId,
        payerId: c.playerId,
        amount: 100,
        now,
      }),
    ])
    expect(outcome.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcome.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(OperationConflictError),
    })
    const purpose = (
      await db
        .selectFrom('wallet_tournament_operation_ids')
        .select('purpose')
        .where('operation_id', '=', c.operationId)
        .executeTakeFirstOrThrow()
    ).purpose
    expect((await account(c.playerId)).balance).toBe(
      purpose === 'PRIZE_CREDITS' ? '1501.5' : '900.5',
    )
  })
})
