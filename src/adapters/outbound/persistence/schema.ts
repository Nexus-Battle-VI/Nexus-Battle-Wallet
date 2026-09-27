import type { ColumnType, Generated } from 'kysely'

import type { StakeHoldStatus } from '../../../domain/value-objects/stake-hold'

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
  readonly reserved: ColumnType<string, string | number | undefined, string | number>
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
  readonly wallet_stake_holds: WalletStakeHoldsTable
  readonly wallet_stake_ledger: WalletStakeLedgerTable
  readonly wallet_auction_holds: WalletAuctionHoldsTable
  readonly wallet_auction_hold_operations: WalletAuctionHoldOperationsTable
  readonly wallet_auction_hold_ledger: WalletAuctionHoldLedgerTable
  readonly wallet_buy_now_transfers: WalletBuyNowTransfersTable
  readonly wallet_buy_now_transfer_operations: WalletBuyNowTransferOperationsTable
  readonly wallet_buy_now_transfer_ledger: WalletBuyNowTransferLedgerTable
  readonly wallet_auction_publication_fees: WalletAuctionPublicationFeesTable
  readonly wallet_auction_publication_fee_refunds: WalletAuctionPublicationFeeRefundsTable
}
export interface WalletAuctionPublicationFeesTable {
  readonly charge_id: string
  readonly operation_id: string
  readonly seller_id: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly status: ColumnType<
    'CHARGED' | 'REFUNDED',
    'CHARGED' | 'REFUNDED',
    'CHARGED' | 'REFUNDED'
  >
  readonly created_at: ColumnType<Date, Date | string, Date | string>
  readonly refunded_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >
}
export interface WalletAuctionPublicationFeeRefundsTable {
  readonly operation_id: string
  readonly charge_id: string
  readonly created_at: ColumnType<Date, Date | string, Date | string>
}

/**
 * Transferencia directa comprador -> vendedor de una compra inmediata
 * (HU-64.8). Sin estado de reserva intermedio: `status` solo distingue si ya
 * se revirtio.
 */
export interface WalletBuyNowTransfersTable {
  readonly id: string
  readonly buyer_id: string
  readonly seller_id: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly status: ColumnType<
    'APPLIED' | 'REVERSED',
    'APPLIED' | 'REVERSED',
    'APPLIED' | 'REVERSED'
  >
  readonly created_at: ColumnType<Date, Date | string, Date | string>
  readonly updated_at: ColumnType<Date, Date | string, Date | string>
}

export interface WalletBuyNowTransferOperationsTable {
  readonly operation_id: string
  readonly intent: unknown
  readonly result: unknown
  readonly created_at: ColumnType<Date, Date | string, Date | string>
}

export interface WalletBuyNowTransferLedgerTable {
  readonly id: Generated<string>
  readonly operation_id: string
  readonly transfer_id: string
  readonly player_id: string
  readonly kind: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly resulting_balance: ColumnType<string, string | number, string | number>
  readonly resulting_reserved: ColumnType<string, string | number, string | number>
  readonly created_at: ColumnType<Date, Date | string, Date | string>
}

/**
 * Estado mutable de cada reserva de apuesta (HU-23). Uno por `operation_id`
 * determinista de reserva; `expires_at` es la red de seguridad de D11.
 */
export interface WalletStakeHoldsTable {
  readonly operation_id: string
  readonly player_id: string
  readonly battle_id: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly status: ColumnType<StakeHoldStatus, StakeHoldStatus, StakeHoldStatus>
  readonly created_at: ColumnType<Date, Date | string | undefined, Date | string>
  readonly updated_at: ColumnType<Date, Date | string | undefined, Date | string>
  readonly expires_at: ColumnType<Date, Date | string, Date | string>
}

export type StakeLedgerKind = 'RESERVE' | 'RELEASE' | 'SETTLE_CAPTURE' | 'SETTLE_CREDIT' | 'EXPIRE'

/** Insert-only: un movimiento por cada llamada aplicada de verdad. */
export interface WalletStakeLedgerTable {
  readonly id: Generated<string>
  readonly operation_id: string
  readonly kind: ColumnType<StakeLedgerKind, StakeLedgerKind, never>
  readonly hold_operation_id: string
  readonly player_id: string
  readonly battle_id: string
  readonly amount: ColumnType<string, string | number, never>
  readonly resulting_balance: ColumnType<string, string | number, never>
  readonly resulting_reserved: ColumnType<string, string | number, never>
  readonly created_at: ColumnType<Date, Date | string | undefined, never>
}

export interface WalletAuctionHoldsTable {
  readonly id: string
  readonly creation_operation_id: string
  readonly player_id: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly auction_id: string
  readonly bid_id: string
  readonly reason: string
  readonly status: ColumnType<
    'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED',
    'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED',
    'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED'
  >
  readonly created_at: ColumnType<Date, Date | string, Date | string>
  readonly updated_at: ColumnType<Date, Date | string, Date | string>
  readonly expires_at: ColumnType<Date, Date | string, Date | string>
}
export interface WalletAuctionHoldOperationsTable {
  readonly operation_id: string
  readonly intent: unknown
  readonly result: unknown
  readonly created_at: ColumnType<Date, Date | string, Date | string>
}
export interface WalletAuctionHoldLedgerTable {
  readonly id: Generated<string>
  readonly operation_id: string
  readonly hold_id: string
  readonly player_id: string
  readonly kind: string
  readonly amount: ColumnType<string, string | number, string | number>
  readonly resulting_balance: ColumnType<string, string | number, string | number>
  readonly resulting_reserved: ColumnType<string, string | number, string | number>
  readonly created_at: ColumnType<Date, Date | string, Date | string>
}
