import { sql, type Kysely } from 'kysely'
/** Conserva recibos e invariantes de 009; una final por ausencia no tiene sala. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`ALTER TABLE wallet_tournament_prize_ledger ALTER COLUMN final_room_id DROP NOT NULL`.execute(
    db,
  )
}
/** PostgreSQL rechaza la reversión si existen recibos por ausencia; no se borran. */
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`ALTER TABLE wallet_tournament_prize_ledger ALTER COLUMN final_room_id SET NOT NULL`.execute(
    db,
  )
}
