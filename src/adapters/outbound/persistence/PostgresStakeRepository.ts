import type { Kysely, Selectable, Transaction } from 'kysely'

import {
  HoldAmountMismatchError,
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
  SettlementNotZeroSumError,
} from '../../../application/errors/StakePersistenceError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import type {
  ReleaseStakeCommand,
  ReserveStakeCommand,
  SettleStakesCommand,
  SettleStakesResult,
  StakeOperationResult,
  StakeRepositoryPort,
  StakeSettlementEntry,
  StakeSettlementResult,
} from '../../../application/ports/StakeRepositoryPort'
import { weekIdentityOf } from '../../../domain/value-objects/week-identity'
import { lockByText } from './advisory-lock'
import type { Database, StakeLedgerKind, WalletStakeLedgerTable } from './schema'

/** Red de seguridad de D11: 24 h desde la reserva. */
export const STAKE_HOLD_TTL_MS = 24 * 60 * 60 * 1000

type StakeTransaction = Transaction<Database>

interface AccountBalance {
  readonly balance: number
  readonly reserved: number
}

/**
 * PostgreSQL es la unica fuente de verdad del dinero (ADR-019). Mismo patron
 * de idempotencia que HU-22: `pg_advisory_xact_lock` sobre `operationId`
 * serializa reintentos de la MISMA operacion; el lock sobre `playerId`
 * serializa operaciones CONCURRENTES sobre la MISMA cuenta.
 *
 * Orden de locks, siempre el mismo, para que no haya interbloqueos: locks de
 * operacion primero, locks de jugador despues, y en `/settle` los jugadores en
 * orden alfabetico determinista.
 */
export class PostgresStakeRepository implements StakeRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  reserve(command: ReserveStakeCommand, clockNow: Date): Promise<StakeOperationResult> {
    return this.db.transaction().execute(async (transaction) => {
      await lockByText(transaction, command.operationId)

      const existingHold = await transaction
        .selectFrom('wallet_stake_holds')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (existingHold !== undefined) {
        const sameIntent =
          existingHold.player_id === command.playerId &&
          existingHold.battle_id === command.battleId &&
          Number(existingHold.amount) === command.amount

        if (!sameIntent) {
          throw new OperationConflictError(command.operationId)
        }

        // Replay: se relee el estado resultante del ledger (insert-only), no
        // se recalcula contra el estado actual de la cuenta -- el resultado
        // del reintento es el de la operacion original, no el de operaciones
        // posteriores que hayan podido mover la cuenta.
        const ledgerRow = await transaction
          .selectFrom('wallet_stake_ledger')
          .selectAll()
          .where('operation_id', '=', command.operationId)
          .where('kind', '=', 'RESERVE')
          .executeTakeFirstOrThrow()

        return {
          operationId: command.operationId,
          applied: false,
          holdId: command.operationId,
          balance: Number(ledgerRow.resulting_balance),
          reserved: Number(ledgerRow.resulting_reserved),
          available: Number(ledgerRow.resulting_balance) - Number(ledgerRow.resulting_reserved),
        }
      }

      await lockByText(transaction, command.playerId)

      const account = await this.ensureAccount(transaction, command.playerId, clockNow)
      const available = account.balance - account.reserved

      if (available < command.amount) {
        // Nada se escribe: la transaccion entera se revierte.
        throw new InsufficientAvailableBalanceError(command.playerId, available, command.amount)
      }

      const nextReserved = account.reserved + command.amount

      await transaction
        .updateTable('wallet_accounts')
        .set({ reserved: nextReserved, updated_at: clockNow })
        .where('player_id', '=', command.playerId)
        .execute()

      await transaction
        .insertInto('wallet_stake_holds')
        .values({
          operation_id: command.operationId,
          player_id: command.playerId,
          battle_id: command.battleId,
          amount: command.amount,
          status: 'ACTIVE',
          created_at: clockNow,
          updated_at: clockNow,
          expires_at: new Date(clockNow.getTime() + STAKE_HOLD_TTL_MS),
        })
        .execute()

      await transaction
        .insertInto('wallet_stake_ledger')
        .values({
          operation_id: command.operationId,
          kind: 'RESERVE',
          hold_operation_id: command.operationId,
          player_id: command.playerId,
          battle_id: command.battleId,
          amount: command.amount,
          resulting_balance: account.balance,
          resulting_reserved: nextReserved,
          created_at: clockNow,
        })
        .execute()

      return {
        operationId: command.operationId,
        applied: true,
        holdId: command.operationId,
        balance: account.balance,
        reserved: nextReserved,
        available: account.balance - nextReserved,
      }
    })
  }

  release(command: ReleaseStakeCommand): Promise<StakeOperationResult> {
    return this.db.transaction().execute(async (transaction) => {
      await lockByText(transaction, command.operationId)

      const existingEntry = await transaction
        .selectFrom('wallet_stake_ledger')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (existingEntry !== undefined) {
        if (existingEntry.hold_operation_id !== command.holdId) {
          throw new OperationConflictError(command.operationId)
        }

        return {
          operationId: command.operationId,
          applied: false,
          holdId: command.holdId,
          balance: Number(existingEntry.resulting_balance),
          reserved: Number(existingEntry.resulting_reserved),
          available:
            Number(existingEntry.resulting_balance) - Number(existingEntry.resulting_reserved),
        }
      }

      const hold = await transaction
        .selectFrom('wallet_stake_holds')
        .selectAll()
        .where('operation_id', '=', command.holdId)
        .executeTakeFirst()

      if (hold === undefined) {
        throw new HoldNotFoundError(command.holdId)
      }

      // El lock de jugador se toma ANTES de releer el hold: asi una
      // liquidacion concurrente (que tambien toma el lock de jugador) no puede
      // cambiar el estado entre la lectura y la mutacion.
      await lockByText(transaction, hold.player_id)

      const lockedHold = await transaction
        .selectFrom('wallet_stake_holds')
        .selectAll()
        .where('operation_id', '=', command.holdId)
        .forUpdate()
        .executeTakeFirstOrThrow()

      const now = new Date()
      const account = await this.ensureAccount(transaction, lockedHold.player_id, now)

      if (lockedHold.status !== 'ACTIVE') {
        // Idempotente respecto al ESTADO: liberar algo ya cerrado (por esta u
        // otra operacion) no falla ni vuelve a tocar `reserved`.
        return {
          operationId: command.operationId,
          applied: false,
          holdId: command.holdId,
          balance: account.balance,
          reserved: account.reserved,
          available: account.balance - account.reserved,
        }
      }

      const holdAmount = Number(lockedHold.amount)
      const nextReserved = account.reserved - holdAmount

      await transaction
        .updateTable('wallet_accounts')
        .set({ reserved: nextReserved, updated_at: now })
        .where('player_id', '=', lockedHold.player_id)
        .execute()

      await transaction
        .updateTable('wallet_stake_holds')
        .set({ status: 'RELEASED', updated_at: now })
        .where('operation_id', '=', command.holdId)
        .execute()

      await transaction
        .insertInto('wallet_stake_ledger')
        .values({
          operation_id: command.operationId,
          kind: 'RELEASE',
          hold_operation_id: command.holdId,
          player_id: lockedHold.player_id,
          battle_id: lockedHold.battle_id,
          amount: holdAmount,
          resulting_balance: account.balance,
          resulting_reserved: nextReserved,
          created_at: now,
        })
        .execute()

      return {
        operationId: command.operationId,
        applied: true,
        holdId: command.holdId,
        balance: account.balance,
        reserved: nextReserved,
        available: account.balance - nextReserved,
      }
    })
  }

  settle(command: SettleStakesCommand): Promise<SettleStakesResult> {
    return this.db.transaction().execute(async (transaction) => {
      await lockByText(transaction, command.operationId)

      const existingEntries = await transaction
        .selectFrom('wallet_stake_ledger')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .orderBy('id')
        .execute()

      if (existingEntries.length > 0) {
        if (!sameSettlementIntent(existingEntries, command.settlements)) {
          throw new OperationConflictError(command.operationId)
        }

        return {
          operationId: command.operationId,
          applied: false,
          results: existingEntries.map((entry) => ({
            playerId: entry.player_id,
            holdId: entry.hold_operation_id,
            balance: Number(entry.resulting_balance),
            reserved: Number(entry.resulting_reserved),
            available: Number(entry.resulting_balance) - Number(entry.resulting_reserved),
          })),
        }
      }

      // Orden determinista (alfabetico) para que dos liquidaciones que
      // compartan un jugador no puedan interbloquearse entre si.
      const playerIds = [...new Set(command.settlements.map((entry) => entry.playerId))].sort()
      for (const playerId of playerIds) {
        await lockByText(transaction, playerId)
      }

      const now = new Date()
      const results: StakeSettlementResult[] = []
      let capturedTotal = 0
      let creditedTotal = 0

      for (const entry of command.settlements) {
        const hold = await transaction
          .selectFrom('wallet_stake_holds')
          .selectAll()
          .where('operation_id', '=', entry.holdId)
          .forUpdate()
          .executeTakeFirst()

        // El hold debe existir, ser del jugador que lo declara, pertenecer a
        // ESTA batalla y seguir `ACTIVE`: Wallet no confia en el numero que
        // Combat reenvia, lo valida contra su propio registro.
        if (
          hold?.player_id !== entry.playerId ||
          hold.battle_id !== command.battleId ||
          hold.status !== 'ACTIVE'
        ) {
          throw new HoldNotFoundError(entry.holdId)
        }

        const holdAmount = Number(hold.amount)

        if (entry.outcome === 'CAPTURED' && holdAmount !== entry.amount) {
          throw new HoldAmountMismatchError(entry.holdId, holdAmount, entry.amount)
        }

        if (entry.outcome === 'CAPTURED') {
          capturedTotal += entry.amount
        } else {
          creditedTotal += entry.amount
        }

        const account = await this.ensureAccount(transaction, entry.playerId, now)
        const nextBalance =
          entry.outcome === 'CAPTURED'
            ? account.balance - entry.amount
            : account.balance + entry.amount
        // Lo que se libera de `reserved` es el monto ORIGINAL del hold, no el
        // `amount` de la entrada (en un CREDITED es la parte ajena del pozo).
        const nextReserved = account.reserved - holdAmount

        await transaction
          .updateTable('wallet_accounts')
          .set({ balance: nextBalance, reserved: nextReserved, updated_at: now })
          .where('player_id', '=', entry.playerId)
          .execute()

        await transaction
          .updateTable('wallet_stake_holds')
          .set({ status: entry.outcome === 'CAPTURED' ? 'CAPTURED' : 'RELEASED', updated_at: now })
          .where('operation_id', '=', entry.holdId)
          .execute()

        await transaction
          .insertInto('wallet_stake_ledger')
          .values({
            operation_id: command.operationId,
            kind: entry.outcome === 'CAPTURED' ? 'SETTLE_CAPTURE' : 'SETTLE_CREDIT',
            hold_operation_id: entry.holdId,
            player_id: entry.playerId,
            battle_id: command.battleId,
            amount: entry.amount,
            resulting_balance: nextBalance,
            resulting_reserved: nextReserved,
            created_at: now,
          })
          .execute()

        results.push({
          playerId: entry.playerId,
          holdId: entry.holdId,
          balance: nextBalance,
          reserved: nextReserved,
          available: nextBalance - nextReserved,
        })
      }

      // Segunda comprobacion de suma cero, ahora contra lo que de verdad se
      // aplico. La primera (de forma) la hizo el caso de uso; esta defiende la
      // invariante incluso si el repositorio se usara sin pasar por el.
      if (capturedTotal !== creditedTotal) {
        throw new SettlementNotZeroSumError(
          `se capturan ${String(capturedTotal)} y se acreditan ${String(creditedTotal)}.`,
        )
      }

      return { operationId: command.operationId, applied: true, results }
    })
  }

  async expireStale(clockNow: Date, limit: number): Promise<number> {
    const candidates = await this.db
      .selectFrom('wallet_stake_holds')
      .select('operation_id')
      .where('status', '=', 'ACTIVE')
      .where('expires_at', '<=', clockNow)
      .orderBy('expires_at')
      .limit(limit)
      .execute()

    let expired = 0

    for (const candidate of candidates) {
      const didExpire = await this.db.transaction().execute(async (transaction) => {
        const hold = await transaction
          .selectFrom('wallet_stake_holds')
          .selectAll()
          .where('operation_id', '=', candidate.operation_id)
          .executeTakeFirst()

        if (hold === undefined) {
          return false
        }

        await lockByText(transaction, hold.player_id)

        const lockedHold = await transaction
          .selectFrom('wallet_stake_holds')
          .selectAll()
          .where('operation_id', '=', candidate.operation_id)
          .forUpdate()
          .executeTakeFirst()

        // Otra instancia (u otra operacion) pudo cerrarlo entre el listado y
        // el lock: se salta, nunca se libera dos veces.
        if (
          lockedHold?.status !== 'ACTIVE' ||
          lockedHold.expires_at.getTime() > clockNow.getTime()
        ) {
          return false
        }

        const account = await this.ensureAccount(transaction, lockedHold.player_id, clockNow)
        const holdAmount = Number(lockedHold.amount)
        const nextReserved = account.reserved - holdAmount

        await transaction
          .updateTable('wallet_accounts')
          .set({ reserved: nextReserved, updated_at: clockNow })
          .where('player_id', '=', lockedHold.player_id)
          .execute()

        await transaction
          .updateTable('wallet_stake_holds')
          .set({ status: 'EXPIRED', updated_at: clockNow })
          .where('operation_id', '=', candidate.operation_id)
          .execute()

        await transaction
          .insertInto('wallet_stake_ledger')
          .values({
            operation_id: `${candidate.operation_id}:expire`,
            kind: 'EXPIRE',
            hold_operation_id: candidate.operation_id,
            player_id: lockedHold.player_id,
            battle_id: lockedHold.battle_id,
            amount: holdAmount,
            resulting_balance: account.balance,
            resulting_reserved: nextReserved,
            created_at: clockNow,
          })
          .execute()

        return true
      })

      if (didExpire) {
        expired += 1
      }
    }

    return expired
  }

  /**
   * Garantiza que la fila de la cuenta existe y la devuelve bloqueada
   * (`FOR UPDATE`). Se crea con la identidad de la semana del instante dado:
   * una cuenta nueva no tiene historial de cofres que conservar.
   */
  private async ensureAccount(
    transaction: StakeTransaction,
    playerId: string,
    now: Date,
  ): Promise<AccountBalance> {
    await transaction
      .insertInto('wallet_accounts')
      .values({
        player_id: playerId,
        balance: 0,
        reserved: 0,
        victory_progress: 0,
        weekly_chest_count: 0,
        week_identity: weekIdentityOf(now),
      })
      .onConflict((conflict) => conflict.column('player_id').doNothing())
      .execute()

    const row = await transaction
      .selectFrom('wallet_accounts')
      .selectAll()
      .where('player_id', '=', playerId)
      .forUpdate()
      .executeTakeFirstOrThrow()

    return { balance: Number(row.balance), reserved: Number(row.reserved) }
  }
}

/**
 * Compara la intencion completa de una liquidacion contra lo que quedo en el
 * ledger, por CONJUNTO (el orden no importa) y no por posicion. El `kind`
 * distingue un `CAPTURED` de un `CREDITED`.
 */
const sameSettlementIntent = (
  stored: readonly Selectable<WalletStakeLedgerTable>[],
  settlements: readonly StakeSettlementEntry[],
): boolean => {
  if (stored.length !== settlements.length) {
    return false
  }

  const keyOf = (playerId: string, holdId: string, kind: StakeLedgerKind, amount: number): string =>
    `${playerId}\u0000${holdId}\u0000${kind}\u0000${String(amount)}`

  const storedKeys = new Set(
    stored.map((entry) =>
      keyOf(entry.player_id, entry.hold_operation_id, entry.kind, Number(entry.amount)),
    ),
  )
  const requestedKeys = new Set(
    settlements.map((entry) =>
      keyOf(
        entry.playerId,
        entry.holdId,
        entry.outcome === 'CAPTURED' ? 'SETTLE_CAPTURE' : 'SETTLE_CREDIT',
        entry.amount,
      ),
    ),
  )

  return (
    storedKeys.size === requestedKeys.size && [...storedKeys].every((key) => requestedKeys.has(key))
  )
}
