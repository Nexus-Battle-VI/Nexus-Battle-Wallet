import { sql, type Kysely } from 'kysely'

/** HU-65.2: holds de subasta, separados de las apuestas de HU-23. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_auction_holds')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('creation_operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('bid_id', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('wallet_auction_holds_amount_positive', sql`amount > 0`)
    .addCheckConstraint('wallet_auction_holds_reason_valid', sql`reason = 'AUCTION_BID'`)
    .addCheckConstraint(
      'wallet_auction_holds_status_valid',
      sql`status in ('ACTIVE','CAPTURED','RELEASED','EXPIRED')`,
    )
    .addCheckConstraint('wallet_auction_holds_dates_valid', sql`expires_at > created_at`)
    .execute()
  await db.schema
    .createIndex('wallet_auction_holds_auction_bid_idx')
    .on('wallet_auction_holds')
    .columns(['auction_id', 'bid_id'])
    .execute()
  await db.schema
    .createIndex('wallet_auction_holds_status_expires_idx')
    .on('wallet_auction_holds')
    .columns(['status', 'expires_at'])
    .execute()
  await db.schema
    .createTable('wallet_auction_hold_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('intent', 'jsonb', (column) => column.notNull())
    .addColumn('result', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createTable('wallet_auction_hold_ledger')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('operation_id', 'text', (column) => column.notNull())
    .addColumn('hold_id', 'text', (column) => column.notNull())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('amount', 'bigint', (column) => column.notNull())
    .addColumn('resulting_balance', 'bigint', (column) => column.notNull())
    .addColumn('resulting_reserved', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint(
      'wallet_auction_hold_ledger_kind_valid',
      sql`kind in ('AUCTION_HOLD_RESERVED','AUCTION_HOLD_RELEASED','AUCTION_HOLD_CAPTURED','AUCTION_SETTLEMENT_CREDIT','AUCTION_HOLD_EXPIRED')`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_auction_hold_ledger').execute()
  await db.schema.dropTable('wallet_auction_hold_operations').execute()
  await db.schema.dropTable('wallet_auction_holds').execute()
}
