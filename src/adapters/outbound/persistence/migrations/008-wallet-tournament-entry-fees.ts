import { sql, type Kysely } from 'kysely'

/** Aditiva sobre 007: tarifa entera, saldo exacto con medios créditos. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_tournament_entry_fees')
    .addColumn('charge_id', 'text', (c) => c.primaryKey())
    .addColumn('operation_id', 'text', (c) => c.notNull().unique())
    .addColumn('tournament_id', 'text', (c) => c.notNull())
    .addColumn('team_id', 'text', (c) => c.notNull())
    .addColumn('payer_id', 'text', (c) => c.notNull())
    .addColumn('amount', 'bigint', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('refunded_at', 'timestamptz')
    .addCheckConstraint(
      'wallet_entry_fee_amount_positive',
      sql`amount > 0 and amount <= 9007199254740991`,
    )
    .addCheckConstraint(
      'wallet_entry_fee_identifiers_valid',
      sql`
      charge_id = operation_id
      and length(btrim(operation_id)) > 0 and length(operation_id) <= 200
      and length(btrim(tournament_id)) > 0 and length(tournament_id) <= 200
      and length(btrim(team_id)) > 0 and length(team_id) <= 200
      and length(btrim(payer_id)) > 0 and length(payer_id) <= 200
    `,
    )
    .addCheckConstraint(
      'wallet_entry_fee_status_valid',
      sql`status in ('CHARGED','REFUNDED','REJECTED')`,
    )
    .addCheckConstraint(
      'wallet_entry_fee_refunded_at_valid',
      sql`
      (status = 'REFUNDED' and refunded_at is not null)
      or (status <> 'REFUNDED' and refunded_at is null)
    `,
    )
    .execute()
  await db.schema
    .createTable('wallet_tournament_entry_fee_refunds')
    .addColumn('operation_id', 'text', (c) => c.primaryKey())
    .addColumn('charge_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint(
      'wallet_entry_fee_refund_operation_valid',
      sql`
      length(btrim(operation_id)) > 0 and length(operation_id) <= 200
    `,
    )
    .addForeignKeyConstraint(
      'wallet_entry_fee_refunds_charge_fk',
      ['charge_id'],
      'wallet_tournament_entry_fees',
      ['charge_id'],
    )
    .execute()
  await db.schema
    .createIndex('wallet_entry_fee_refunds_charge_idx')
    .on('wallet_tournament_entry_fee_refunds')
    .column('charge_id')
    .execute()
  await db.schema
    .createIndex('wallet_entry_fee_payer_status_idx')
    .on('wallet_tournament_entry_fees')
    .columns(['payer_id', 'status'])
    .execute()
  await db.schema
    .createTable('wallet_tournament_entry_ledger')
    .addColumn('operation_id', 'text', (c) => c.primaryKey())
    .addColumn('charge_id', 'text', (c) =>
      c.notNull().references('wallet_tournament_entry_fees.charge_id'),
    )
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('amount', 'bigint', (c) => c.notNull())
    .addColumn('resulting_balance', 'numeric', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('entry_ledger_kind', sql`kind in ('CHARGE','REFUND')`)
    .addCheckConstraint(
      'entry_ledger_balance',
      sql`
      resulting_balance >= 0 and resulting_balance % 0.5 = 0
      and amount > 0 and amount <= 9007199254740991
    `,
    )
    .addUniqueConstraint('wallet_entry_ledger_charge_kind_unique', ['charge_id', 'kind'])
    .execute()
}
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_tournament_entry_ledger').execute()
  await db.schema.dropTable('wallet_tournament_entry_fee_refunds').execute()
  await db.schema.dropTable('wallet_tournament_entry_fees').execute()
}
