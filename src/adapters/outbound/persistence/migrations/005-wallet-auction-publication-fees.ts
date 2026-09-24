import { sql, type Kysely } from 'kysely'
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_auction_publication_fees')
    .addColumn('charge_id', 'text', (c) => c.primaryKey())
    .addColumn('operation_id', 'text', (c) => c.notNull().unique())
    .addColumn('seller_id', 'text', (c) => c.notNull())
    .addColumn('amount', 'bigint', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('refunded_at', 'timestamptz')
    .addCheckConstraint('wallet_publication_fee_amount_positive', sql`amount > 0`)
    .addCheckConstraint(
      'wallet_publication_fee_status_valid',
      sql`status in ('CHARGED','REFUNDED')`,
    )
    .execute()
  await db.schema
    .createTable('wallet_auction_publication_fee_refunds')
    .addColumn('operation_id', 'text', (c) => c.primaryKey())
    .addColumn('charge_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addForeignKeyConstraint(
      'wallet_publication_fee_refunds_charge_fk',
      ['charge_id'],
      'wallet_auction_publication_fees',
      ['charge_id'],
    )
    .execute()
  await db.schema
    .createIndex('wallet_publication_fee_refunds_charge_idx')
    .on('wallet_auction_publication_fee_refunds')
    .column('charge_id')
    .execute()
  await db.schema
    .createIndex('wallet_publication_fee_seller_status_idx')
    .on('wallet_auction_publication_fees')
    .columns(['seller_id', 'status'])
    .execute()
}
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_auction_publication_fee_refunds').execute()
  await db.schema.dropTable('wallet_auction_publication_fees').execute()
}
