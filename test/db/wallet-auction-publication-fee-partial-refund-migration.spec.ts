import { startTestPostgres } from '../support/postgres'
import { sql, type Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

/**
 * HU-90 (PR1 Wallet): la migracion 007 debe poder aplicarse sobre un esquema
 * YA EXISTENTE con datos (no solo sobre una base limpia, que ya cubre
 * `postgres-database.spec.ts` al aplicar `MIGRATIONS` completo de una vez).
 *
 * Reproduce exactamente el escenario de produccion: 001-006 ya aplicadas,
 * con filas reales de `wallet_accounts` (bigint) y de refunds historicos
 * (sin `amount`, porque esa columna no existia), y comprueba que 007
 * convierte los tipos sin perder datos y completa (`backfill`) cada refund
 * historico con el monto que de verdad se cobro.
 */
describe('Migracion 007: wallet_accounts/wallet_ledger a numeric + amount de refund', () => {
  let container: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  const preMigration007 = Object.fromEntries(
    Object.entries(MIGRATIONS).filter(([name]) => name < '007'),
  )

  beforeAll(async () => {
    container = await startTestPostgres()
    db = createDatabase({ connectionString: container.connectionString })
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('upgrades a populated 001-006 schema without losing data, and backfills historical refunds', async () => {
    const before = await migrateToLatest(db, preMigration007)
    expect(before.error).toBeUndefined()
    expect(before.applied).toEqual(Object.keys(preMigration007))

    // Datos reales anteriores a este PR: saldo entero (bigint) y un refund
    // TOTAL historico, hecho cuando `wallet_auction_publication_fee_refunds`
    // todavia no tenia columna `amount`.
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values ('seller-pre-007',10,0,'2026-09-21')`.execute(
      db,
    )
    await sql`insert into wallet_auction_publication_fees (charge_id,operation_id,seller_id,amount,status,created_at,refunded_at) values ('charge-pre-007','charge-pre-007','seller-pre-007',3,'REFUNDED','2026-09-21T00:00:00Z','2026-09-22T00:00:00Z')`.execute(
      db,
    )
    await sql`insert into wallet_auction_publication_fee_refunds (operation_id,charge_id,created_at) values ('refund-pre-007','charge-pre-007','2026-09-22T00:00:00Z')`.execute(
      db,
    )

    const through007 = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([name]) => name < '008'),
    )
    const after = await migrateToLatest(db, through007)
    expect(after.error).toBeUndefined()
    expect(after.applied).toEqual(['007-wallet-auction-publication-fee-partial-refund'])

    // El saldo entero preexistente se conserva exacto tras bigint -> numeric.
    const account = await sql<{
      balance: string
    }>`select balance from wallet_accounts where player_id='seller-pre-007'`.execute(db)
    expect(account.rows[0]?.balance).toBe('10')

    // El refund historico (total) queda completado con el monto que
    // realmente se cobro (3), no con NULL ni con 0.
    const refund = await sql<{
      amount: string
    }>`select amount from wallet_auction_publication_fee_refunds where operation_id='refund-pre-007'`.execute(
      db,
    )
    expect(refund.rows[0]?.amount).toBe('3')

    // El tipo de columna es numeric y las columnas nuevas quedan NOT NULL.
    const columns = await sql<{
      column_name: string
      data_type: string
      is_nullable: string
    }>`select column_name,data_type,is_nullable from information_schema.columns
       where table_name='wallet_auction_publication_fee_refunds' and column_name='amount'`.execute(
      db,
    )
    expect(columns.rows).toEqual([
      { column_name: 'amount', data_type: 'numeric', is_nullable: 'NO' },
    ])
  }, 120_000)
})
