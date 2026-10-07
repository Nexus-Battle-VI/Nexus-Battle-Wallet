import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  TournamentCreditsPrize,
  TournamentCreditsPrizeReceipt,
  TournamentPrizeRepositoryPort,
} from '../../../application/ports/TournamentPrizeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import { claimTournamentOperation } from './PostgresTournamentOperationRegistry'
import type { Database } from './schema'

export class PostgresTournamentPrizeRepository implements TournamentPrizeRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  credit(command: TournamentCreditsPrize, now: Date): Promise<TournamentCreditsPrizeReceipt> {
    return this.db.transaction().execute(async (tx) => {
      await claimTournamentOperation(tx, command.operationId, 'PRIZE_CREDITS', now)
      const stored = await tx
        .selectFrom('wallet_tournament_prize_ledger')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()
      if (stored) {
        const receipt: TournamentCreditsPrizeReceipt = {
          operationId: stored.operation_id,
          tournamentId: stored.tournament_id,
          championTeamId: stored.champion_team_id,
          finalEncounterId: stored.final_encounter_id,
          finalRoomId: stored.final_room_id,
          playerId: stored.player_id,
          heroId: stored.hero_id,
          kind: 'CREDITS',
          amount: stored.amount,
          productId: null,
          status: 'DELIVERED',
          receiptId: stored.receipt_id,
        }
        if (
          Object.entries(command).some(
            ([key, value]) => receipt[key as keyof TournamentCreditsPrizeReceipt] !== value,
          )
        )
          throw new OperationConflictError(command.operationId)
        return receipt
      }
      await lockByText(tx, command.playerId)
      await tx
        .insertInto('wallet_accounts')
        .values({
          player_id: command.playerId,
          balance: '0',
          reserved: '0',
          victory_progress: 0,
          weekly_chest_count: 0,
          week_identity: weekIdentityOf(now),
          updated_at: now,
        })
        .onConflict((c) => c.column('player_id').doNothing())
        .execute()
      // UPDATE bloquea la única cuenta de Wallet y suma en numeric, incluso sobre 2^53.
      const account = await tx
        .updateTable('wallet_accounts')
        .set({
          balance: sql`balance + ${command.amount}::numeric`,
          updated_at: now,
        })
        .where('player_id', '=', command.playerId)
        .returning(['balance', 'reserved'])
        .executeTakeFirstOrThrow()
      const receiptId = randomUUID()
      await tx
        .insertInto('wallet_tournament_prize_ledger')
        .values({
          operation_id: command.operationId,
          purpose: 'PRIZE_CREDITS',
          receipt_id: receiptId,
          tournament_id: command.tournamentId,
          champion_team_id: command.championTeamId,
          final_encounter_id: command.finalEncounterId,
          final_room_id: command.finalRoomId,
          player_id: command.playerId,
          hero_id: command.heroId,
          amount: command.amount,
          resulting_balance: account.balance,
          resulting_reserved: account.reserved,
          created_at: now,
        })
        .execute()
      return { ...command, status: 'DELIVERED', receiptId }
    })
  }
}
