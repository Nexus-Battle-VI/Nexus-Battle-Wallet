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
/**
 * Se pidio liberar un hold cuyos creditos ya se capturaron hacia el vendedor.
 * Distinto de `AuctionHoldStateError` a proposito: quien libera necesita saber
 * que esos creditos NO volvieron al postor, a diferencia de un hold ya
 * liberado o expirado, cuyo release es un no-op exitoso.
 */
export class AuctionHoldAlreadyCapturedError extends Error {
  constructor(readonly holdId: string) {
    super(`El hold de subasta ${holdId} ya fue capturado y no puede liberarse.`)
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
