import { sql, type Kysely } from 'kysely'

/**
 * HU-22 (Task HU-22.2). Primeras tablas de negocio de Wallet: el andamiaje
 * no creaba ninguna (README, "No tiene todavia ninguna ruta de negocio").
 *
 * `wallet_accounts` guarda el estado ACTUAL (mutable) por jugador: saldo,
 * progreso de victoria y contador semanal de cofres. `wallet_ledger` es
 * insert-only: cada movimiento queda con el estado resultante completo, lo
 * que permite responder un replay del mismo `operationId` sin recalcular
 * nada (contrato S3: un retry nunca cambia `chestEarned`).
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_accounts')
    .addColumn('player_id', 'text', (column) => column.primaryKey())
    .addColumn('balance', 'bigint', (column) => column.notNull().defaultTo(0))
    .addColumn('victory_progress', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('weekly_chest_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('week_identity', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('wallet_accounts_balance_non_negative', sql`balance >= 0`)
    .addCheckConstraint('wallet_accounts_victory_progress_non_negative', sql`victory_progress >= 0`)
    .addCheckConstraint(
      'wallet_accounts_weekly_chest_count_non_negative',
      sql`weekly_chest_count >= 0`,
    )
    .execute()

  await db.schema
    .createTable('wallet_ledger')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('battle_id', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('credits_amount', 'integer', (column) => column.notNull())
    .addColumn('victory_credits_amount', 'integer', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('resulting_balance', 'bigint', (column) => column.notNull())
    .addColumn('resulting_victory_progress', 'integer', (column) => column.notNull())
    .addColumn('resulting_weekly_chest_count', 'integer', (column) => column.notNull())
    .addColumn('resulting_week_identity', 'text', (column) => column.notNull())
    .addColumn('chest_earned', 'boolean', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('wallet_ledger_credits_amount_positive', sql`credits_amount > 0`)
    .addCheckConstraint(
      'wallet_ledger_victory_credits_amount_non_negative',
      sql`victory_credits_amount >= 0`,
    )
    .execute()

  await db.schema
    .createIndex('wallet_ledger_player_id_idx')
    .on('wallet_ledger')
    .column('player_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_ledger').execute()
  await db.schema.dropTable('wallet_accounts').execute()
}
