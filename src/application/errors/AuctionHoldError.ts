export class AuctionHoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`No existe el hold de subasta ${holdId}.`)
  }
}
export class AuctionHoldInsufficientBalanceError extends Error {
  constructor() {
    super('El saldo disponible no alcanza para el hold de subasta.')
  }
}
export class AuctionHoldStateError extends Error {
  constructor() {
    super('El hold de subasta no esta ACTIVE.')
  }
}
export class AuctionHoldReferenceError extends Error {
  constructor() {
    super('La referencia de Auction no coincide con el hold.')
  }
}
export class InvalidAuctionHoldDateError extends Error {
  constructor() {
    super('La fecha de cierre de la subasta es invalida.')
  }
}
export class ExpiredAuctionHoldDateError extends Error {
  constructor() {
    super('La fecha de cierre de la subasta ya vencio.')
  }
}
export class AuctionHoldDateTooFarError extends Error {
  constructor() {
    super('La fecha de cierre de la subasta supera el maximo permitido.')
  }
}
