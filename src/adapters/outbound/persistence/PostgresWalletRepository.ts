import { sql, type Kysely } from 'kysely'

import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  CreditBattleRewardCommand,
  CreditBattleRewardResult,
  WalletRepositoryPort,
  WalletStateSnapshot,
} from '../../../application/ports/WalletRepositoryPort'
import { WEEKLY_CHEST_LIMIT } from '../../../domain/policies/ChestEligibilityPolicy'
import { computeNextWalletState } from '../../../application/services/WalletStateTransition'
import type { Database } from './schema'

/**
 * PostgreSQL es la unica fuente de verdad del saldo y del progreso de cofre
 * (ADR-019, HU-22). Sigue el mismo patron de idempotencia que ya usa
 * `PostgresAuctionRepository` (Auction, Team Gama): un `pg_advisory_xact_lock`
 * sobre `operationId` serializa reintentos de la MISMA operacion, y un
 * segundo lock sobre `playerId` serializa operaciones CONCURRENTES sobre la
 * MISMA cuenta -- necesario para que el umbral de 20 y el limite de 2
 * cofres/semana no se rompan bajo carrera cuando dos batallas del mismo
 * jugador terminan casi a la vez.
 */
export class PostgresWalletRepository implements WalletRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  creditBattleReward(
    command: CreditBattleRewardCommand,
    currentWeekIdentity: string,
  ): Promise<CreditBattleRewardResult> {
    return this.db.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtext(${command.operationId}))`.execute(transaction)

      const existing = await transaction
        .selectFrom('wallet_ledger')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (existing !== undefined) {
        const sameIntent =
          existing.player_id === command.playerId &&
          existing.battle_id === command.battleId &&
          existing.credits_amount === command.creditsAmount &&
          existing.victory_credits_amount === command.victoryCreditsAmount

        if (!sameIntent) {
          throw new OperationConflictError(command.operationId)
        }

        return {
          operationId: command.operationId,
          applied: false,
          balance: Number(existing.resulting_balance),
          victoryProgress: existing.resulting_victory_progress,
          weeklyChestCount: existing.resulting_weekly_chest_count,
          weeklyChestLimit: WEEKLY_CHEST_LIMIT,
          weekIdentity: existing.resulting_week_identity,
          chestEarned: existing.chest_earned,
        }
      }

      // Serializa operaciones CONCURRENTES sobre la MISMA cuenta: sin esto,
      // dos creditos simultaneos del mismo jugador podrian leer el mismo
      // progreso de partida y producir dos cofres cuando solo corresponde uno.
      await sql`select pg_advisory_xact_lock(hashtext(${command.playerId}))`.execute(transaction)

      await transaction
        .insertInto('wallet_accounts')
        .values({
          player_id: command.playerId,
          balance: 0,
          victory_progress: 0,
          weekly_chest_count: 0,
          week_identity: currentWeekIdentity,
        })
        .onConflict((conflict) => conflict.column('player_id').doNothing())
        .execute()

      const row = await transaction
        .selectFrom('wallet_accounts')
        .selectAll()
        .where('player_id', '=', command.playerId)
        .forUpdate()
        .executeTakeFirstOrThrow()

      const next = computeNextWalletState(
        {
          balance: Number(row.balance),
          victoryProgress: row.victory_progress,
          weeklyChestCount: row.weekly_chest_count,
          weekIdentity: row.week_identity,
        },
        currentWeekIdentity,
        command.creditsAmount,
        command.victoryCreditsAmount,
      )

      await transaction
        .updateTable('wallet_accounts')
        .set({
          balance: next.balance,
          victory_progress: next.victoryProgress,
          weekly_chest_count: next.weeklyChestCount,
          week_identity: next.weekIdentity,
          updated_at: new Date(),
        })
        .where('player_id', '=', command.playerId)
        .execute()

      await transaction
        .insertInto('wallet_ledger')
        .values({
          operation_id: command.operationId,
          player_id: command.playerId,
          battle_id: command.battleId,
          reason: command.reason,
          credits_amount: command.creditsAmount,
          victory_credits_amount: command.victoryCreditsAmount,
          occurred_at: command.occurredAt,
          resulting_balance: next.balance,
          resulting_victory_progress: next.victoryProgress,
          resulting_weekly_chest_count: next.weeklyChestCount,
          resulting_week_identity: next.weekIdentity,
          chest_earned: next.chestEarned,
        })
        .execute()

      return {
        operationId: command.operationId,
        applied: true,
        balance: next.balance,
        victoryProgress: next.victoryProgress,
        weeklyChestCount: next.weeklyChestCount,
        weeklyChestLimit: WEEKLY_CHEST_LIMIT,
        weekIdentity: next.weekIdentity,
        chestEarned: next.chestEarned,
      }
    })
  }

  async getSnapshot(playerId: string, currentWeekIdentity: string): Promise<WalletStateSnapshot> {
    const row = await this.db
      .selectFrom('wallet_accounts')
      .selectAll()
      .where('player_id', '=', playerId)
      .executeTakeFirst()

    if (row === undefined) {
      return {
        balance: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weeklyChestLimit: WEEKLY_CHEST_LIMIT,
        weekIdentity: currentWeekIdentity,
      }
    }

    const weeklyChestCount = row.week_identity === currentWeekIdentity ? row.weekly_chest_count : 0

    return {
      balance: Number(row.balance),
      victoryProgress: row.victory_progress,
      weeklyChestCount,
      weeklyChestLimit: WEEKLY_CHEST_LIMIT,
      weekIdentity: currentWeekIdentity,
    }
  }
}
