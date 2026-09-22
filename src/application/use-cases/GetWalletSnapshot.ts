import { weekIdentityOf } from '../../domain/value-objects/week-identity'
import type { ClockPort } from '../ports/ClockPort'
import type { WalletRepositoryPort, WalletStateSnapshot } from '../ports/WalletRepositoryPort'
import { VICTORY_PROGRESS_THRESHOLD } from '../../domain/policies/ChestEligibilityPolicy'

export interface WalletSnapshotView extends WalletStateSnapshot {
  readonly threshold: number
}

/** `GET /api/v1/wallet/me` (Task HU-22.2, S4 del contrato). */
export class GetWalletSnapshot {
  constructor(
    private readonly wallet: WalletRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(playerId: string): Promise<WalletSnapshotView> {
    const currentWeekIdentity = weekIdentityOf(this.clock.now())
    const snapshot = await this.wallet.getSnapshot(playerId, currentWeekIdentity)

    return { ...snapshot, threshold: VICTORY_PROGRESS_THRESHOLD }
  }
}

export const GET_WALLET_SNAPSHOT = Symbol('GetWalletSnapshot')
