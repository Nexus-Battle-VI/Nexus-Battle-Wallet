export class AuctionPublicationFeeInsufficientBalanceError extends Error {
  constructor() {
    super('El saldo disponible no alcanza para la comision de publicacion.')
  }
}
export class AuctionPublicationFeeNotFoundError extends Error {
  constructor(chargeId: string) {
    super(`No existe la comision de publicacion ${chargeId}.`)
  }
}
export class InvalidAuctionPublicationFeeAmountError extends Error {
  constructor() {
    super('La comision de publicacion debe ser un entero positivo.')
  }
}
