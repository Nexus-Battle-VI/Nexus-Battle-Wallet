import {
  InvalidMissionRewardAmountError,
  MissionRewardSchemaError,
} from '../errors/MissionRewardError'
import type { ClockPort } from '../ports/ClockPort'
import {
  MISSION_REWARD_DIFFICULTIES,
  type CreditMissionRewardResult,
  type MissionRewardDifficulty,
  type MissionRewardRepositoryPort,
} from '../ports/MissionRewardRepositoryPort'
import { weekIdentityOf } from '../../domain/value-objects/week-identity'

/** Version del esquema del contrato interno (`hu-10-mission-completion-reward-v1` §9.2). */
export const MISSION_REWARD_SCHEMA_VERSION = 1

/** Unico motivo de este contrato. Distinto de `BATTLE_REWARD` (HU-22). */
export const MISSION_REWARD_REASON = 'MISSION_REWARD'

/** Grupos de una entrada de creditos (contrato §12). `completion` es la XP: no aplica aqui. */
const CREDIT_REWARD_GROUPS = ['guaranteed', 'objective-bonus', 'first-time'] as const

const MAX_TEXT = 200

export interface CreditMissionRewardInput {
  readonly schemaVersion: unknown
  readonly operationId: unknown
  readonly playerId: unknown
  readonly reason: unknown
  readonly enrollmentId: unknown
  readonly missionId: unknown
  readonly difficulty: unknown
  readonly rewardKey: unknown
  readonly creditsAmount: unknown
  readonly occurredAt: unknown
}

/**
 * Credito de mision (HU-10, Task HU-10.3; `hu-10-mission-completion-reward-v1` §9).
 *
 * QUE HACE Y QUE NO. Valida el contrato de entrada y delega. **No decide
 * cuantos creditos vale una mision, una dificultad o un desenlace**: el importe
 * llega ya congelado desde Missions y aqui solo se comprueba su FORMA (entero,
 * `>= 1`, dentro del rango seguro del saldo). No consulta a Missions, no usa el
 * catalogo cerrado `{1, 2, 4}` de HU-22 y no evalua progreso de victoria ni cofres.
 *
 * `occurredAt` es el `settledAt` congelado de la liquidacion: se conserva tal
 * cual, porque forma parte del contenido que se compara en un reintento. Usar la
 * hora de Wallet haria que un replay legitimo pareciera otra operacion (`409`).
 *
 * LA SEMANA SOLO SIRVE PARA CREAR UNA CUENTA NUEVA (`week_identity` es `NOT
 * NULL`). Una cuenta existente conserva su semana, su progreso de victoria y su
 * contador de cofres exactamente como estaban.
 */
export class CreditMissionReward {
  constructor(
    private readonly rewards: MissionRewardRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: CreditMissionRewardInput): Promise<CreditMissionRewardResult> {
    if (input.schemaVersion !== MISSION_REWARD_SCHEMA_VERSION) {
      throw new MissionRewardSchemaError(
        `schemaVersion debe ser ${String(MISSION_REWARD_SCHEMA_VERSION)}.`,
      )
    }

    const enrollmentId = requireText(input.enrollmentId, 'enrollmentId')
    const rewardKey = requireRewardKey(input.rewardKey)
    const operationId = requireText(input.operationId, 'operationId')
    const expected = `mission:${enrollmentId}:reward:${rewardKey}`

    // La clave la fija el contrato a partir de la matricula y de la linea: una
    // que no corresponde no puede ser esta acreditacion, y aceptarla dejaria dos
    // claves para el mismo derecho.
    if (operationId !== expected) {
      throw new MissionRewardSchemaError(
        `El operationId de un credito de mision debe ser ${expected}.`,
      )
    }

    if (input.reason !== MISSION_REWARD_REASON) {
      throw new MissionRewardSchemaError(`reason debe ser ${MISSION_REWARD_REASON}.`)
    }

    const command = {
      operationId,
      playerId: requireText(input.playerId, 'playerId'),
      enrollmentId,
      missionId: requireText(input.missionId, 'missionId'),
      difficulty: requireDifficulty(input.difficulty),
      rewardKey,
      creditsAmount: requireAmount(input.creditsAmount),
      occurredAt: requireInstant(input.occurredAt),
      initialWeekIdentity: weekIdentityOf(this.clock.now()),
    }

    return this.rewards.creditMissionReward(command)
  }
}

export const CREDIT_MISSION_REWARD = Symbol('CreditMissionReward')

const requireText = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_TEXT) {
    throw new MissionRewardSchemaError(
      `${field} debe ser una cadena de 1 a ${String(MAX_TEXT)} caracteres.`,
    )
  }

  return raw
}

const requireRewardKey = (raw: unknown): string => {
  const key = requireText(raw, 'rewardKey')
  const [group, ...rest] = key.split(':')

  if (
    !(CREDIT_REWARD_GROUPS as readonly string[]).includes(group ?? '') ||
    rest.length === 0 ||
    rest.some((part) => part.length === 0)
  ) {
    throw new MissionRewardSchemaError(
      `rewardKey debe ser {${CREDIT_REWARD_GROUPS.join('|')}}:{key}.`,
    )
  }

  return key
}

const requireDifficulty = (raw: unknown): MissionRewardDifficulty => {
  if (
    typeof raw !== 'string' ||
    !(MISSION_REWARD_DIFFICULTIES as readonly string[]).includes(raw)
  ) {
    throw new MissionRewardSchemaError(
      `difficulty debe ser uno de ${MISSION_REWARD_DIFFICULTIES.join(', ')}.`,
    )
  }

  return raw as MissionRewardDifficulty
}

/** Un instante ISO-8601 valido. Un texto que no lo es, o un tipo distinto, es `400`. */
const requireInstant = (raw: unknown): Date => {
  if (typeof raw !== 'string') {
    throw new MissionRewardSchemaError('occurredAt debe ser un instante ISO-8601.')
  }

  const instant = new Date(raw)

  if (Number.isNaN(instant.getTime())) {
    throw new MissionRewardSchemaError('occurredAt debe ser un instante ISO-8601 valido.')
  }

  return instant
}

/**
 * El importe: un numero (un texto es un cuerpo mal formado, `400`) que sea un
 * entero `>= 1` dentro del rango seguro (`422`, porque el cuerpo esta bien formado
 * y lo que incumple es una regla).
 */
const requireAmount = (raw: unknown): number => {
  if (typeof raw !== 'number') {
    throw new MissionRewardSchemaError('creditsAmount debe ser un numero.')
  }

  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new InvalidMissionRewardAmountError(
      `creditsAmount debe ser un entero entre 1 y ${String(Number.MAX_SAFE_INTEGER)}. Se recibio ${String(raw)}.`,
    )
  }

  return raw
}
