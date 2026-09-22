import type { ColumnType, Generated } from 'kysely'

/**
 * Esquema de la base de datos del servicio, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Cada migracion que cree o cambie una tabla debe reflejarse
 * aqui en el mismo Pull Request.
 *
 * Nombres de columna en `snake_case`, que es la convencion de PostgreSQL. La
 * traduccion a la instantanea del agregado ocurre en un `mapping.ts` explicito.
 */
export interface WalletAccountsTable {
  readonly player_id: string
  readonly balance: ColumnType<string, string | number | undefined, string | number>
  readonly victory_progress: ColumnType<number, number | undefined, number>
  readonly weekly_chest_count: ColumnType<number, number | undefined, number>
  readonly week_identity: string
  readonly updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface WalletLedgerTable {
  readonly id: Generated<string>
  readonly operation_id: string
  readonly player_id: string
  readonly battle_id: string
  readonly reason: string
  readonly credits_amount: number
  readonly victory_credits_amount: number
  readonly occurred_at: ColumnType<Date, Date | string, Date | string>
  readonly resulting_balance: ColumnType<string, string | number, never>
  readonly resulting_victory_progress: number
  readonly resulting_weekly_chest_count: number
  readonly resulting_week_identity: string
  readonly chest_earned: boolean
  readonly created_at: ColumnType<Date, Date | string | undefined, never>
}

export interface Database {
  readonly wallet_accounts: WalletAccountsTable
  readonly wallet_ledger: WalletLedgerTable
}
