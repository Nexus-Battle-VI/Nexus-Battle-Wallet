export class TournamentEntryFeeInsufficientBalanceError extends Error {
  constructor() {
    super('El saldo disponible no alcanza para la inscripción al torneo.')
  }
}
export class TournamentEntryFeeNotFoundError extends Error {
  constructor(chargeId: string) {
    super(`No existe el cobro de inscripción ${chargeId}.`)
  }
}
export class InvalidTournamentEntryFeeAmountError extends Error {
  constructor() {
    super(
      'La tarifa debe ser un entero positivo seguro y los identificadores texto no vacío de hasta 200 caracteres.',
    )
  }
}
