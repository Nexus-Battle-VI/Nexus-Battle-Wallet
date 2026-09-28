import { sql, type Kysely } from 'kysely'

/**
 * Creditos de mision (HU-10, Task HU-10.3; `hu-10-mission-completion-reward-v1` §9).
 *
 * UN LEDGER PROPIO, no una ampliacion de `wallet_ledger`. Ese ledger es de
 * HU-22 (JcJ): exige `battle_id`, `victory_credits_amount`, el progreso de
 * victoria, la semana y `chest_earned`, y su `credits_amount` sigue el catalogo
 * cerrado `{1, 2, 4}`. Un credito de mision no tiene batalla ni progreso de
 * victoria; meterlo ahi obligaria a columnas nulas o valores falsos y mezclaria
 * dos semanticas. Sigue el patron que Wallet ya usa para comisiones, retenciones y
 * transferencias de subasta: una tabla por tipo de operacion, con `operation_id`
 * unico.
 *
 * INSERT-ONLY, y lo impone el motor: un trigger rechaza `UPDATE` y `DELETE`. Un
 * movimiento de saldo no se edita ni se borra; si hubiera que corregirlo seria
 * otro movimiento.
 *
 * `(enrollment_id, reward_key)` es UNICO: una linea de recompensa de una matricula
 * se acredita una sola vez aunque llegara con otro `operation_id`.
 *
 * ADITIVA Y HACIA ADELANTE: no toca `wallet_ledger`, `wallet_accounts` ni ninguna
 * tabla existente, y no reescribe ningun asiento de HU-22. Importes en `bigint`,
 * como el saldo.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('wallet_mission_reward_credits')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('enrollment_id', 'text', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) => column.notNull())
    .addColumn('difficulty', 'text', (column) => column.notNull())
    .addColumn('reward_key', 'text', (column) => column.notNull())
    .addColumn('credits_amount', 'bigint', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('resulting_balance', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('wallet_mission_reward_credits_amount_positive', sql`credits_amount >= 1`)
    .addCheckConstraint('wallet_mission_reward_credits_reason', sql`reason = 'MISSION_REWARD'`)
    .addCheckConstraint(
      'wallet_mission_reward_credits_difficulty',
      sql`difficulty in ('NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC')`,
    )
    .addCheckConstraint(
      'wallet_mission_reward_credits_balance_covers_credit',
      sql`resulting_balance >= credits_amount`,
    )
    .addUniqueConstraint('wallet_mission_reward_credits_line_unique', [
      'enrollment_id',
      'reward_key',
    ])
    .execute()

  await db.schema
    .createIndex('wallet_mission_reward_credits_player_idx')
    .on('wallet_mission_reward_credits')
    .column('player_id')
    .execute()

  await sql`create or replace function wallet_mission_reward_credits_insert_only()
    returns trigger language plpgsql as $$
    begin
      raise exception 'wallet_mission_reward_credits es insert-only: % no esta permitido', tg_op;
    end;
    $$`.execute(db)

  await sql`create trigger wallet_mission_reward_credits_insert_only
    before update or delete on wallet_mission_reward_credits
    for each row execute function wallet_mission_reward_credits_insert_only()`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('wallet_mission_reward_credits').execute()
  await sql`drop function if exists wallet_mission_reward_credits_insert_only()`.execute(db)
}
