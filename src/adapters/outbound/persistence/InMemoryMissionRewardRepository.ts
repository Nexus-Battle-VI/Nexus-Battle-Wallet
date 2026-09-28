import { InvalidMissionRewardAmountError } from '../../../application/errors/MissionRewardError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  CreditMissionRewardCommand,
  CreditMissionRewardResult,
  MissionRewardRepositoryPort,
} from '../../../application/ports/MissionRewardRepositoryPort'
import { InMemoryWalletStore } from './InMemoryWalletStore'

/**
 * Credito de mision en memoria (HU-10, Task HU-10.3): doble de pruebas y de
 * `PERSISTENCE_DRIVER=memory`, con la MISMA semantica que
 * `PostgresMissionRewardRepository`. Comparte el almacen con los demas dobles para
 * que `GET /wallet/me` vea la misma cuenta.
 *
 * Incrementa SOLO `balance`: no toca el progreso de victoria, el contador semanal
 * ni la semana de una cuenta existente. Sin `await` entre comprobar y escribir.
 */
export class InMemoryMissionRewardRepository implements MissionRewardRepositoryPort {
  constructor(private readonly store: InMemoryWalletStore = new InMemoryWalletStore()) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async creditMissionReward(
    command: CreditMissionRewardCommand,
  ): Promise<CreditMissionRewardResult> {
    const intent = JSON.stringify([
      command.playerId,
      command.enrollmentId,
      command.missionId,
      command.difficulty,
      command.rewardKey,
      command.creditsAmount,
      command.occurredAt.getTime(),
    ])
    const previous = this.store.missionRewardCredits.get(command.operationId)

    if (previous !== undefined) {
      if (previous.intent !== intent) {
        throw new OperationConflictError(command.operationId)
      }

      return { operationId: command.operationId, applied: false, balance: previous.balance }
    }

    const account = this.store.accounts.get(command.playerId) ?? {
      balance: 0,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: command.initialWeekIdentity,
    }
    const balance = account.balance + command.creditsAmount

    if (!Number.isSafeInteger(balance)) {
      throw new InvalidMissionRewardAmountError(
        'El credito llevaria el saldo fuera del rango seguro.',
      )
    }

    // SOLO el saldo: el progreso JcJ y la semana se conservan tal cual.
    this.store.accounts.set(command.playerId, { ...account, balance })
    this.store.missionRewardCredits.set(command.operationId, { intent, balance })

    return { operationId: command.operationId, applied: true, balance }
  }
}
