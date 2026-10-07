export type AuctionHoldStatus = 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED'

/**
 * Motivos con los que Auction libera un hold. `AUCTION_CANCELLED` (HU-90,
 * CA-05) cubre la cancelacion de la subasta, donde se libera a TODOS los
 * postores, incluido el lider: ni fue superado ni perdio una liquidacion.
 * El motivo forma parte de la huella de idempotencia de la operacion.
 */
export const AUCTION_HOLD_RELEASE_REASONS = [
  'AUCTION_OUTBID',
  'AUCTION_SETTLEMENT_LOST',
  'AUCTION_CANCELLED',
] as const

export type AuctionHoldReleaseReason = (typeof AUCTION_HOLD_RELEASE_REASONS)[number]
export interface AuctionHoldResult {
  readonly operationId: string
  readonly holdId: string
  readonly holdStatus: AuctionHoldStatus
  readonly applied: boolean
  readonly beneficiaryPlayerId?: string
}
export interface CreateAuctionHold {
  readonly operationId: string
  readonly playerId: string
  readonly amount: number
  readonly auctionId: string
  readonly bidId: string
  readonly closesAt: Date
  readonly now: Date
  readonly graceMs: number
}
export interface CaptureAuctionHold {
  readonly operationId: string
  readonly holdId: string
  readonly beneficiaryPlayerId: string
  readonly auctionId: string
  readonly winningBidId: string
  readonly now: Date
}
export interface ReleaseAuctionHold {
  readonly operationId: string
  readonly holdId: string
  readonly reason: AuctionHoldReleaseReason
  readonly now: Date
}
export interface AuctionHoldRepositoryPort {
  create(command: CreateAuctionHold): Promise<AuctionHoldResult>
  capture(command: CaptureAuctionHold): Promise<AuctionHoldResult>
  /**
   * Liberar es idempotente por ESTADO, ademas de por `operationId`:
   * - `ACTIVE`: libera la reserva (`applied: true`, `holdStatus: RELEASED`).
   * - `RELEASED` / `EXPIRED`: los creditos ya no estan retenidos; responde
   *   sin mover saldo ni escribir ledger (`applied: false`, con el estado
   *   real del hold).
   * - `CAPTURED`: los creditos ya se transfirieron; lanza
   *   `AuctionHoldAlreadyCapturedError`, nunca un exito.
   */
  release(command: ReleaseAuctionHold): Promise<AuctionHoldResult>
  expire(now: Date): Promise<number>
}
export const AUCTION_HOLD_REPOSITORY = Symbol('AuctionHoldRepositoryPort')
