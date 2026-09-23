import { sql, type Kysely } from 'kysely'

/** HU-64.8: transferencia directa comprador -> vendedor para compra inmediata, separada de los holds de puja (HU-65.2/HU-23). */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_buy_now_transfers')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('buyer_id', 'text', (column) => column.notNull())
    .addColumn('seller_id', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('wallet_buy_now_transfers_amount_positive', sql`amount > 0`)
    .addCheckConstraint(
      'wallet_buy_now_transfers_status_valid',
      sql`status in ('APPLIED','REVERSED')`,
    )
    .addCheckConstraint('wallet_buy_now_transfers_parties_distinct', sql`buyer_id <> seller_id`)
    .execute()
  await db.schema
    .createIndex('wallet_buy_now_transfers_buyer_idx')
    .on('wallet_buy_now_transfers')
    .column('buyer_id')
    .execute()
  await db.schema
    .createIndex('wallet_buy_now_transfers_seller_idx')
    .on('wallet_buy_now_transfers')
    .column('seller_id')
    .execute()
  await db.schema
    .createTable('wallet_buy_now_transfer_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('intent', 'jsonb', (column) => column.notNull())
    .addColumn('result', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createTable('wallet_buy_now_transfer_ledger')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('operation_id', 'text', (column) => column.notNull())
    .addColumn('transfer_id', 'text', (column) => column.notNull())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('resulting_balance', 'bigint', (column) => column.notNull())
    .addColumn('resulting_reserved', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint(
      'wallet_buy_now_transfer_ledger_kind_valid',
      sql`kind in ('BUY_NOW_DEBIT','BUY_NOW_CREDIT','BUY_NOW_REVERSAL_CREDIT','BUY_NOW_REVERSAL_DEBIT')`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_buy_now_transfer_ledger').execute()
  await db.schema.dropTable('wallet_buy_now_transfer_operations').execute()
  await db.schema.dropTable('wallet_buy_now_transfers').execute()
}
