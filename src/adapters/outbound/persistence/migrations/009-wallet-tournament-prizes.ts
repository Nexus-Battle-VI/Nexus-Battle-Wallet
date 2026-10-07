import { sql, type Kysely } from 'kysely'

/** Aditiva sobre 008. No cambia cuentas, saldos, fracciones ni historiales aplicados. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_tournament_operation_ids')
    .addColumn('operation_id', 'text', (c) => c.primaryKey())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('wallet_tournament_operation_purpose_unique', ['operation_id', 'purpose'])
    .addCheckConstraint(
      'wallet_tournament_operation_purpose_valid',
      sql`purpose in ('ENTRY_CHARGE','ENTRY_REFUND','PRIZE_CREDITS')`,
    )
    .execute()
  // Incluye los rechazos durables de HU-84: tampoco liberan su operationId.
  await sql`insert into wallet_tournament_operation_ids (operation_id,purpose,created_at)
    select operation_id,'ENTRY_CHARGE',created_at from wallet_tournament_entry_fees
    union all select operation_id,'ENTRY_REFUND',created_at from wallet_tournament_entry_fee_refunds`.execute(
    db,
  )
  await db.schema
    .createTable('wallet_tournament_prize_ledger')
    .addColumn('operation_id', 'text', (c) => c.primaryKey())
    .addColumn('purpose', 'text', (c) => c.notNull().defaultTo('PRIZE_CREDITS'))
    .addColumn('receipt_id', 'uuid', (c) => c.notNull().unique())
    .addColumn('tournament_id', 'text', (c) => c.notNull())
    .addColumn('champion_team_id', 'text', (c) => c.notNull())
    .addColumn('final_encounter_id', 'text', (c) => c.notNull())
    .addColumn('final_room_id', 'text', (c) => c.notNull())
    .addColumn('player_id', 'text', (c) => c.notNull().references('wallet_accounts.player_id'))
    .addColumn('hero_id', 'text', (c) => c.notNull())
    .addColumn('amount', 'bigint', (c) => c.notNull())
    .addColumn('resulting_balance', 'numeric', (c) => c.notNull())
    .addColumn('resulting_reserved', 'numeric', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addForeignKeyConstraint(
      'wallet_prize_operation_fk',
      ['operation_id', 'purpose'],
      'wallet_tournament_operation_ids',
      ['operation_id', 'purpose'],
    )
    .addCheckConstraint('wallet_prize_purpose_valid', sql`purpose = 'PRIZE_CREDITS'`)
    .addCheckConstraint('wallet_prize_amount_valid', sql`amount > 0 and amount <= 9007199254740991`)
    .addCheckConstraint(
      'wallet_prize_balances_valid',
      sql`resulting_balance >= amount and resulting_balance % 0.5 = 0 and resulting_reserved >= 0 and resulting_reserved % 1 = 0 and resulting_reserved <= resulting_balance`,
    )
    .addCheckConstraint(
      'wallet_prize_references_valid',
      sql`
      length(operation_id) between 1 and 512 and operation_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(tournament_id) between 1 and 160 and tournament_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(champion_team_id) between 1 and 160 and champion_team_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(final_encounter_id) between 1 and 512 and final_encounter_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(final_room_id) between 1 and 160 and final_room_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(player_id) between 1 and 160 and player_id ~ '^[^[:space:]](.*[^[:space:]])?$'
      and length(hero_id) between 1 and 160 and hero_id ~ '^[^[:space:]](.*[^[:space:]])?$'
    `,
    )
    .execute()
  await db.schema
    .createIndex('wallet_prize_player_created_idx')
    .on('wallet_tournament_prize_ledger')
    .columns(['player_id', 'created_at'])
    .execute()
  await db.schema
    .createIndex('wallet_prize_tournament_idx')
    .on('wallet_tournament_prize_ledger')
    .column('tournament_id')
    .execute()
  // Recibo y propósito son insert-only. La recuperación nunca edita el movimiento.
  await sql`create function wallet_tournament_prize_immutable() returns trigger language plpgsql as $$
    begin raise exception 'El ledger de premios es inmutable' using errcode = '23514'; end;
  $$`.execute(db)
  await sql`create trigger wallet_prize_immutable before update or delete on wallet_tournament_prize_ledger
    for each row execute function wallet_tournament_prize_immutable()`.execute(db)
}

/** Reversión estructural explícita; no deshace acreditaciones ya confirmadas. */
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_tournament_prize_ledger').execute()
  await sql`drop function wallet_tournament_prize_immutable()`.execute(db)
  await db.schema.dropTable('wallet_tournament_operation_ids').execute()
}
