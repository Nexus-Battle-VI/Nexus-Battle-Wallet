import { sql, type Kysely } from 'kysely'

/**
 * HU-90 (PR1 Wallet, `7.7.10`): el 50% de penalizacion de una subasta
 * cancelada se calcula sobre `publicationFeeCredits` (1 credito -> 0.5; 3
 * creditos -> 1.5), asi que un reembolso de comision de publicacion ya no es
 * siempre el monto completo.
 *
 * `wallet_accounts.balance`/`reserved` pasan de `bigint` a `numeric` SIN
 * precision/escala declarada: Postgres los guarda exactos para cualquier
 * tamano, asi que no hay una escala arbitrariamente pequena que un saldo
 * futuro mayor pudiera romper. La granularidad permitida se impone con un
 * CHECK, no con la escala de la columna:
 * - `balance` admite multiplos de 0.5 (la unica fraccion que hoy existe).
 * - `reserved` SIGUE restringido a enteros (`% 1 = 0`): ningun flujo de
 *   holds (pujas de HU-65.2, stakes de HU-23, buy-now de HU-64.8) debe
 *   empezar a aceptar fracciones. Sus propias guardas `Number.isInteger()`
 *   en la capa de aplicacion no cambian; este CHECK es una segunda defensa
 *   a nivel de motor.
 *
 * `wallet_ledger.resulting_balance` (HU-22) es el espejo historico de
 * `balance` en cada movimiento: cambia de tipo igual, por el mismo motivo,
 * sin anadirle un CHECK propio (la tabla nunca tuvo uno en `resulting_balance`).
 *
 * Nada mas cambia de tipo. `wallet_auction_holds`, `wallet_stake_holds`,
 * `wallet_buy_now_transfers` y `wallet_mission_reward_credits` siguen en
 * `bigint` enteros: ninguno necesita representar una fraccion.
 *
 * `wallet_auction_publication_fee_refunds` gana `amount`: antes de este PR
 * todo refund era total, asi que las filas existentes se completan con el
 * monto de su `wallet_auction_publication_fees.amount` antes de imponer
 * `NOT NULL`.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('wallet_accounts')
    .alterColumn('balance', (column) => column.setDataType('numeric'))
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .alterColumn('reserved', (column) => column.setDataType('numeric'))
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .addCheckConstraint('wallet_accounts_balance_half_credit', sql`balance % 0.5 = 0`)
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .addCheckConstraint('wallet_accounts_reserved_whole_credit', sql`reserved % 1 = 0`)
    .execute()

  await db.schema
    .alterTable('wallet_ledger')
    .alterColumn('resulting_balance', (column) => column.setDataType('numeric'))
    .execute()

  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .addColumn('amount', 'numeric')
    .execute()
  await sql`
    update wallet_auction_publication_fee_refunds r
    set amount = f.amount
    from wallet_auction_publication_fees f
    where f.charge_id = r.charge_id and r.amount is null
  `.execute(db)
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .alterColumn('amount', (column) => column.setNotNull())
    .execute()
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .addCheckConstraint('wallet_publication_fee_refund_amount_positive', sql`amount > 0`)
    .execute()
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .addCheckConstraint('wallet_publication_fee_refund_amount_half_credit', sql`amount % 0.5 = 0`)
    .execute()
}

/**
 * LIMITACION CONOCIDA: `numeric -> bigint` falla si para entonces existe
 * algun `balance`/`reserved`/`resulting_balance` con valor fraccionario
 * (p.ej. 9.5), porque ese valor no cabe en `bigint`. No se agrega redondeo
 * ni truncamiento para "resolverlo": una vez que exista dinero real en
 * medios creditos, revertir esta migracion implica decidir que hacer con
 * esa fraccion, y esa es una decision de producto, no una regla tecnica a
 * inventar aqui.
 */
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .dropConstraint('wallet_publication_fee_refund_amount_half_credit')
    .execute()
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .dropConstraint('wallet_publication_fee_refund_amount_positive')
    .execute()
  await db.schema
    .alterTable('wallet_auction_publication_fee_refunds')
    .dropColumn('amount')
    .execute()

  await db.schema
    .alterTable('wallet_ledger')
    .alterColumn('resulting_balance', (column) => column.setDataType('bigint'))
    .execute()

  await db.schema
    .alterTable('wallet_accounts')
    .dropConstraint('wallet_accounts_reserved_whole_credit')
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .dropConstraint('wallet_accounts_balance_half_credit')
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .alterColumn('reserved', (column) => column.setDataType('bigint'))
    .execute()
  await db.schema
    .alterTable('wallet_accounts')
    .alterColumn('balance', (column) => column.setDataType('bigint'))
    .execute()
}
