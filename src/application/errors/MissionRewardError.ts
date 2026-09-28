/**
 * Cuerpo de un credito de mision fuera del contrato (HU-10, Task HU-10.3;
 * `hu-10-mission-completion-reward-v1` §9): un campo que falta, que no es del
 * tipo esperado, una `schemaVersion` distinta, un `reason` que no es
 * `MISSION_REWARD`, o un `operationId` que no corresponde a la matricula y a la
 * `rewardKey` del propio cuerpo. Responde `400 SCHEMA_INVALID`.
 */
export class MissionRewardSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissionRewardSchemaError'
  }
}

/**
 * El importe de un credito de mision incumple una regla del contrato: no es un
 * entero, es menor que 1 o sobrepasa el rango seguro del saldo. Responde `422
 * MISSION_REWARD_INVALID`.
 *
 * Es una guarda TECNICA del ledger. Wallet no decide cuantos creditos vale una
 * mision ni una dificultad: eso es contenido congelado de Missions.
 */
export class InvalidMissionRewardAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMissionRewardAmountError'
  }
}
