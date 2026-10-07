import { sql, type Kysely, type Transaction } from 'kysely'
import { TournamentEntryFeeNotFoundError } from '../../../application/errors/TournamentEntryFeeError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  TournamentEntryFeeRepositoryPort,
  TournamentEntryFeeResult,
  ChargeTournamentEntryFee,
  RefundTournamentEntryFee,
} from '../../../application/ports/TournamentEntryFeeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import { claimTournamentOperation } from './PostgresTournamentOperationRegistry'
import type { Database } from './schema'
type Tx = Transaction<Database>
export class PostgresTournamentEntryFeeRepository implements TournamentEntryFeeRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  charge(c: ChargeTournamentEntryFee): Promise<TournamentEntryFeeResult> {
    return this.db.transaction().execute(async (tx) => {
      await claimTournamentOperation(tx, c.operationId, 'ENTRY_CHARGE', c.now)
      await lockByText(tx, `tournament-entry:${c.operationId}`)
      const refundOperation = await tx
        .selectFrom('wallet_tournament_entry_fee_refunds')
        .select('operation_id')
        .where('operation_id', '=', c.operationId)
        .executeTakeFirst()
      if (refundOperation) throw new OperationConflictError(c.operationId)
      const existing = await tx
        .selectFrom('wallet_tournament_entry_fees')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .forUpdate()
        .executeTakeFirst()
      if (existing) {
        if (
          existing.tournament_id !== c.tournamentId ||
          existing.team_id !== c.teamId ||
          existing.payer_id !== c.payerId ||
          Number(existing.amount) !== c.amount
        )
          throw new OperationConflictError(c.operationId)
        return this.result(c.operationId, existing, false)
      }
      await lockByText(tx, c.payerId)
      await this.account(tx, c.payerId, c.now)
      // PostgreSQL hace la aritmética numeric exacta. Convertir el saldo a Number
      // perdería medios créditos y precisión en saldos grandes de la migración 007.
      const debit = await tx
        .updateTable('wallet_accounts')
        .set({ balance: sql`balance - ${c.amount}`, updated_at: c.now })
        .where('player_id', '=', c.payerId)
        .where(sql<boolean>`balance - reserved >= ${c.amount}`)
        .returning('balance')
        .executeTakeFirst()
      if (!debit) {
        await tx
          .insertInto('wallet_tournament_entry_fees')
          .values({
            charge_id: c.operationId,
            operation_id: c.operationId,
            payer_id: c.payerId,
            tournament_id: c.tournamentId,
            team_id: c.teamId,
            amount: c.amount,
            status: 'REJECTED',
            created_at: c.now,
            refunded_at: null,
          })
          .execute()
        return {
          operationId: c.operationId,
          chargeId: c.operationId,
          payerId: c.payerId,
          tournamentId: c.tournamentId,
          teamId: c.teamId,
          amount: c.amount,
          status: 'REJECTED' as const,
          applied: false,
        }
      }
      await tx
        .insertInto('wallet_tournament_entry_fees')
        .values({
          charge_id: c.operationId,
          operation_id: c.operationId,
          payer_id: c.payerId,
          tournament_id: c.tournamentId,
          team_id: c.teamId,
          amount: c.amount,
          status: 'CHARGED',
          created_at: c.now,
          refunded_at: null,
        })
        .execute()
      await tx
        .insertInto('wallet_tournament_entry_ledger')
        .values({
          operation_id: c.operationId,
          charge_id: c.operationId,
          kind: 'CHARGE',
          amount: c.amount,
          resulting_balance: debit.balance,
          created_at: c.now,
        })
        .execute()
      return {
        operationId: c.operationId,
        chargeId: c.operationId,
        payerId: c.payerId,
        tournamentId: c.tournamentId,
        teamId: c.teamId,
        amount: c.amount,
        status: 'CHARGED',
        applied: true,
      }
    })
  }
  refund(c: RefundTournamentEntryFee): Promise<TournamentEntryFeeResult> {
    return this.db.transaction().execute(async (tx) => {
      await claimTournamentOperation(tx, c.operationId, 'ENTRY_REFUND', c.now)
      await lockByText(tx, `tournament-entry:${c.operationId}`)
      const chargeOperation = await tx
        .selectFrom('wallet_tournament_entry_fees')
        .select('operation_id')
        .where('operation_id', '=', c.operationId)
        .executeTakeFirst()
      if (chargeOperation) throw new OperationConflictError(c.operationId)
      const reused = await tx
        .selectFrom('wallet_tournament_entry_fee_refunds')
        .selectAll()
        .where('operation_id', '=', c.operationId)
        .executeTakeFirst()
      if (reused && reused.charge_id !== c.chargeId) throw new OperationConflictError(c.operationId)
      const fee = await tx
        .selectFrom('wallet_tournament_entry_fees')
        .selectAll()
        .where('charge_id', '=', c.chargeId)
        .forUpdate()
        .executeTakeFirst()
      if (!fee || fee.status === 'REJECTED') throw new TournamentEntryFeeNotFoundError(c.chargeId)
      if (reused) return this.result(c.operationId, fee, false)
      await tx
        .insertInto('wallet_tournament_entry_fee_refunds')
        .values({ operation_id: c.operationId, charge_id: c.chargeId, created_at: c.now })
        .execute()
      if (fee.status === 'REFUNDED') return this.result(c.operationId, fee, false)
      await lockByText(tx, fee.payer_id)
      await this.account(tx, fee.payer_id, c.now)
      const credit = await tx
        .updateTable('wallet_accounts')
        .set({ balance: sql`balance + ${fee.amount}::bigint`, updated_at: c.now })
        .where('player_id', '=', fee.payer_id)
        .returning('balance')
        .executeTakeFirstOrThrow()
      await tx
        .updateTable('wallet_tournament_entry_fees')
        .set({ status: 'REFUNDED', refunded_at: c.now })
        .where('charge_id', '=', fee.charge_id)
        .execute()
      await tx
        .insertInto('wallet_tournament_entry_ledger')
        .values({
          operation_id: c.operationId,
          charge_id: fee.charge_id,
          kind: 'REFUND',
          amount: fee.amount,
          resulting_balance: credit.balance,
          created_at: c.now,
        })
        .execute()
      return {
        operationId: c.operationId,
        chargeId: fee.charge_id,
        payerId: fee.payer_id,
        tournamentId: fee.tournament_id,
        teamId: fee.team_id,
        amount: Number(fee.amount),
        status: 'REFUNDED',
        applied: true,
      }
    })
  }
  private result(
    operationId: string,
    row: {
      charge_id: string
      tournament_id: string
      team_id: string
      payer_id: string
      amount: string | number
      status: 'CHARGED' | 'REFUNDED' | 'REJECTED'
    },
    applied: boolean,
  ): TournamentEntryFeeResult {
    return {
      operationId,
      chargeId: row.charge_id,
      payerId: row.payer_id,
      tournamentId: row.tournament_id,
      teamId: row.team_id,
      amount: Number(row.amount),
      status: row.status,
      applied,
    }
  }
  private async account(tx: Tx, id: string, now: Date): Promise<void> {
    await tx
      .insertInto('wallet_accounts')
      .values({
        player_id: id,
        balance: 0,
        reserved: 0,
        victory_progress: 0,
        weekly_chest_count: 0,
        week_identity: weekIdentityOf(now),
      })
      .onConflict((c) => c.column('player_id').doNothing())
      .execute()
    await tx
      .selectFrom('wallet_accounts')
      .select('player_id')
      .where('player_id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow()
  }
}
