/**
 * El mismo `operationId` llego con un cuerpo distinto (`battleId`, `playerId`,
 * `creditsAmount` o `victoryCreditsAmount`). Nunca se reaplica el credito.
 */
export class OperationConflictError extends Error {
  constructor(operationId: string) {
    super(`El operationId ${operationId} ya se uso con una solicitud distinta.`)
    this.name = 'OperationConflictError'
  }
}
