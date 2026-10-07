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
export class InvalidAuctionPublicationFeeRefundAmountError extends Error {
  constructor() {
    super('El monto a reembolsar debe ser positivo y multiplo de 0.5.')
  }
}
export class AuctionPublicationFeeRefundExceedsChargeError extends Error {
  constructor(chargeId: string) {
    super(`El monto a reembolsar supera lo cobrado en la comision ${chargeId}.`)
  }
}
