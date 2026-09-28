import type { Kysely } from 'kysely'

import { InvalidMissionRewardAmountError } from '../../../application/errors/MissionRewardError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  CreditMissionRewardCommand,
  CreditMissionRewardResult,
  MissionRewardRepositoryPort,
} from '../../../application/ports/MissionRewardRepositoryPort'
import { lockByText } from './advisory-lock'
import type { Database } from './schema'

/**
 * Credito de mision sobre PostgreSQL (HU-10, Task HU-10.3;
 * `hu-10-mission-completion-reward-v1` §9).
 *
 * UNA SOLA TRANSACCION: el saldo y el asiento del ledger cambian juntos o no
 * cambia ninguno. Nunca se actualiza el saldo y despues se inserta el asiento por
 * separado.
 *
 * MISMO PATRON DE IDEMPOTENCIA QUE `creditBattleReward` y las comisiones de
 * subasta: un `pg_advisory_xact_lock` sobre `operationId` serializa reintentos de
 * la MISMA operacion, y otro sobre `playerId` serializa operaciones concurrentes
 * sobre la MISMA cuenta.
 *
 * INCREMENTA SOLO `balance`. `victory_progress`, `weekly_chest_count`,
 * `week_identity` y `reserved` de una cuenta existente NO se leen para decidir
 * nada ni se escriben: una mision no es una victoria JcJ. Una cuenta que no existe
 * nace en cero con la semana inicial que trae el comando (`week_identity` es `NOT
 * NULL`), y esa es la unica vez que se escribe.
 */
export class PostgresMissionRewardRepository implements MissionRewardRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  creditMissionReward(command: CreditMissionRewardCommand): Promise<CreditMissionRewardResult> {
    return this.db.transaction().execute(async (transaction) => {
      await lockByText(transaction, command.operationId)

      const existing = await transaction
        .selectFrom('wallet_mission_reward_credits')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (existing !== undefined) {
        // El contenido completo del contrato, no solo el importe. `occurred_at`
        // vuelve de Postgres como `Date`: se compara por valor.
        const sameIntent =
          existing.player_id === command.playerId &&
          existing.reason === 'MISSION_REWARD' &&
          existing.enrollment_id === command.enrollmentId &&
          existing.mission_id === command.missionId &&
          existing.difficulty === command.difficulty &&
          existing.reward_key === command.rewardKey &&
          Number(existing.credits_amount) === command.creditsAmount &&
          existing.occurred_at.getTime() === command.occurredAt.getTime()

        if (!sameIntent) {
          throw new OperationConflictError(command.operationId)
        }

        return {
          operationId: command.operationId,
          applied: false,
          balance: Number(existing.resulting_balance),
        }
      }

      await lockByText(transaction, command.playerId)

      await transaction
        .insertInto('wallet_accounts')
        .values({
          player_id: command.playerId,
          balance: 0,
          reserved: 0,
          victory_progress: 0,
          weekly_chest_count: 0,
          week_identity: command.initialWeekIdentity,
        })
        .onConflict((conflict) => conflict.column('player_id').doNothing())
        .execute()

      const account = await transaction
        .selectFrom('wallet_accounts')
        .select('balance')
        .where('player_id', '=', command.playerId)
        .forUpdate()
        .executeTakeFirstOrThrow()

      const balance = Number(account.balance) + command.creditsAmount

      if (!Number.isSafeInteger(balance)) {
        throw new InvalidMissionRewardAmountError(
          'El credito llevaria el saldo fuera del rango seguro.',
        )
      }

      // SOLO `balance` (y la marca de modificacion): nada del progreso JcJ.
      await transaction
        .updateTable('wallet_accounts')
        .set({ balance, updated_at: new Date() })
        .where('player_id', '=', command.playerId)
        .execute()

      await transaction
        .insertInto('wallet_mission_reward_credits')
        .values({
          operation_id: command.operationId,
          player_id: command.playerId,
          reason: 'MISSION_REWARD',
          enrollment_id: command.enrollmentId,
          mission_id: command.missionId,
          difficulty: command.difficulty,
          reward_key: command.rewardKey,
          credits_amount: command.creditsAmount,
          occurred_at: command.occurredAt,
          resulting_balance: balance,
        })
        .execute()

      return { operationId: command.operationId, applied: true, balance }
    })
  }
}
