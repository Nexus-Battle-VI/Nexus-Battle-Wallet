import type { CreditBattleRewardResult } from '../../../application/ports/WalletRepositoryPort'
import type { StakeHoldStatus } from '../../../domain/value-objects/stake-hold'
import type { StakeLedgerKind } from './schema'

/**
 * Estado compartido de los dobles en memoria (`PERSISTENCE_DRIVER=memory`).
 *
 * Existe un unico almacen por proceso y lo comparten `InMemoryWalletRepository`
 * y `InMemoryStakeRepository`: si cada uno tuviera sus propios mapas,
 * `GET /wallet/me` no veria las reservas hechas por el otro y el doble dejaria
 * de reproducir el comportamiento real (una sola fila por cuenta).
 */
export interface InMemoryAccountState {
  balance: number
  reserved: number
  victoryProgress: number
  weeklyChestCount: number
  weekIdentity: string
}

export interface InMemoryRewardLedgerEntry {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly reason: string
  readonly creditsAmount: number
  readonly victoryCreditsAmount: number
  readonly occurredAt: Date
  readonly result: CreditBattleRewardResult
}

export interface InMemoryStakeHold {
  readonly operationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  status: StakeHoldStatus
  readonly createdAt: Date
  updatedAt: Date
  readonly expiresAt: Date
}

export interface InMemoryStakeLedgerEntry {
  readonly operationId: string
  readonly kind: StakeLedgerKind
  readonly holdOperationId: string
  readonly playerId: string
  readonly battleId: string
  readonly amount: number
  readonly resultingBalance: number
  readonly resultingReserved: number
  readonly createdAt: Date
}

export class InMemoryWalletStore {
  readonly accounts = new Map<string, InMemoryAccountState>()
  readonly rewardLedger = new Map<string, InMemoryRewardLedgerEntry>()
  readonly stakeHolds = new Map<string, InMemoryStakeHold>()
  /** Un arreglo por `operationId`: `/settle` tiene N movimientos (uno por jugador). */
  readonly stakeLedger = new Map<string, InMemoryStakeLedgerEntry[]>()
}
