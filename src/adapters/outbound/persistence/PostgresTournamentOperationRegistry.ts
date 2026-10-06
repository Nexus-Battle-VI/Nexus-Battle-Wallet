import type { Transaction } from 'kysely'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type { Database, TournamentOperationPurpose } from './schema'

/** Una PK para todo el consumidor Tournament, también los cobros y devoluciones previos. */
export const claimTournamentOperation = async (
  tx: Transaction<Database>,
  operationId: string,
  purpose: TournamentOperationPurpose,
  now: Date,
): Promise<void> => {
  // INSERT conflictante espera al commit/rollback del otro proceso/pool.
  await tx
    .insertInto('wallet_tournament_operation_ids')
    .values({ operation_id: operationId, purpose, created_at: now })
    .onConflict((c) => c.column('operation_id').doNothing())
    .execute()
  const owner = await tx
    .selectFrom('wallet_tournament_operation_ids')
    .select('purpose')
    .where('operation_id', '=', operationId)
    .executeTakeFirstOrThrow()
  if (owner.purpose !== purpose) throw new OperationConflictError(operationId)
}
