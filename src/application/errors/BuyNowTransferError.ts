export class BuyNowTransferInsufficientBalanceError extends Error {
  constructor() {
    super('El saldo disponible no alcanza para la compra inmediata.')
  }
}
export class BuyNowTransferSameAccountError extends Error {
  constructor() {
    super('El comprador y el vendedor no pueden ser la misma cuenta.')
  }
}
export class InvalidBuyNowTransferAmountError extends Error {
  constructor() {
    super('El importe de la compra inmediata debe ser un entero positivo.')
  }
}
export class BuyNowTransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`No existe la transferencia de compra inmediata ${transferId}.`)
  }
}
