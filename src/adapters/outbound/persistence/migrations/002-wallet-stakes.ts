import { sql, type Kysely } from 'kysely'

/**
 * HU-23 (Task #434). Apuestas de creditos: reserva, liberacion y liquidacion.
 *
 * Aditiva sobre HU-22: `wallet_accounts` gana `reserved` (nunca toca `balance`
 * reservar; solo capturar o acreditar lo tocan). `wallet_stake_holds` es el
 * estado mutable de cada reserva (uno por `operation_id`, el mismo id
 * determinista que usa Combat); `wallet_stake_ledger` es insert-only, con el
 * estado resultante de cada movimiento, lo que permite responder un replay del
 * mismo `operation_id` sin recalcular nada.
 *
 * La unicidad del ledger es `(operation_id, player_id)`, no `operation_id`
 * sola: `/settle` es UNA operacion por batalla con N movimientos (uno por
 * participante), y cada jugador aparece a lo sumo una vez por liquidacion.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('wallet_accounts')
    .addColumn('reserved', 'bigint', (column) => column.notNull().defaultTo(0))
    .execute()

  await db.schema
    .alterTable('wallet_accounts')
    .addCheckConstraint('wallet_accounts_reserved_non_negative', sql`reserved >= 0`)
    .execute()

  // Invariante de §4.1: `reserved <= balance`. A nivel de tabla porque compara
  // dos columnas de la misma fila.
  await db.schema
    .alterTable('wallet_accounts')
    .addCheckConstraint('wallet_accounts_reserved_within_balance', sql`reserved <= balance`)
    .execute()

  await db.schema
    .createTable('wallet_stake_holds')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('battle_id', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('wallet_stake_holds_amount_positive', sql`amount > 0`)
    .addCheckConstraint(
      'wallet_stake_holds_status_valid',
      sql`status in ('ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED')`,
    )
    .execute()

  await db.schema
    .createIndex('wallet_stake_holds_player_id_idx')
    .on('wallet_stake_holds')
    .column('player_id')
    .execute()

  // Para el barrido de expiracion (D11): holds ACTIVE con `expires_at` vencido.
  await db.schema
    .createIndex('wallet_stake_holds_status_expires_at_idx')
    .on('wallet_stake_holds')
    .columns(['status', 'expires_at'])
    .execute()

  await db.schema
    .createTable('wallet_stake_ledger')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('operation_id', 'text', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('hold_operation_id', 'text', (column) => column.notNull())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('battle_id', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('resulting_balance', 'bigint', (column) => column.notNull())
    .addColumn('resulting_reserved', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('wallet_stake_ledger_operation_player_unique', [
      'operation_id',
      'player_id',
    ])
    .addCheckConstraint(
      'wallet_stake_ledger_kind_valid',
      sql`kind in ('RESERVE', 'RELEASE', 'SETTLE_CAPTURE', 'SETTLE_CREDIT', 'EXPIRE')`,
    )
    .addCheckConstraint(
      'wallet_stake_ledger_resulting_reserved_non_negative',
      sql`resulting_reserved >= 0`,
    )
    .execute()

  await db.schema
    .createIndex('wallet_stake_ledger_player_id_idx')
    .on('wallet_stake_ledger')
    .column('player_id')
    .execute()

  await db.schema
    .createIndex('wallet_stake_ledger_hold_operation_id_idx')
    .on('wallet_stake_ledger')
    .column('hold_operation_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_stake_ledger').execute()
  await db.schema.dropTable('wallet_stake_holds').execute()
  await db.schema
    .alterTable('wallet_accounts')
    .dropConstraint('wallet_accounts_reserved_within_balance')
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .dropConstraint('wallet_accounts_reserved_non_negative')
    .execute()
  await db.schema.alterTable('wallet_accounts').dropColumn('reserved').execute()
}
