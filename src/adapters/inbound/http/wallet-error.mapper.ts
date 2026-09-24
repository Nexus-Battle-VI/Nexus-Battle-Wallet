import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'

import {
  HoldAmountMismatchError,
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
  SettlementNotZeroSumError,
} from '../../../application/errors/StakePersistenceError'
import {
  AuctionHoldDateTooFarError,
  AuctionHoldInsufficientBalanceError,
  AuctionHoldNotFoundError,
  AuctionHoldReferenceError,
  AuctionHoldStateError,
  ExpiredAuctionHoldDateError,
  InvalidAuctionHoldDateError,
} from '../../../application/errors/AuctionHoldError'
import {
  BuyNowTransferInsufficientBalanceError,
  BuyNowTransferNotFoundError,
  BuyNowTransferSameAccountError,
  InvalidBuyNowTransferAmountError,
} from '../../../application/errors/BuyNowTransferError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import { DomainError } from '../../../domain/errors/DomainError'
import { InvalidStakeAmountError } from '../../../domain/value-objects/stake-amount'

const body = (statusCode: number, code: string, message: string): Record<string, unknown> => ({
  statusCode,
  code,
  message,
})

/** Semantica de codigos de HU-59/ADR-019, S3 de HU-22 y §11 de HU-23. */
export const toWalletHttpException = (error: unknown): HttpException => {
  if (error instanceof OperationConflictError) {
    return new ConflictException(body(409, 'OPERATION_CONFLICT', error.message))
  }
  if (error instanceof AuctionHoldNotFoundError)
    return new NotFoundException(body(404, 'HOLD_NOT_FOUND', error.message))
  if (
    error instanceof AuctionHoldInsufficientBalanceError ||
    error instanceof AuctionHoldStateError ||
    error instanceof AuctionHoldReferenceError ||
    error instanceof InvalidAuctionHoldDateError ||
    error instanceof ExpiredAuctionHoldDateError ||
    error instanceof AuctionHoldDateTooFarError
  )
    return new UnprocessableEntityException(body(422, 'AUCTION_HOLD_INVALID', error.message))

  // Compra inmediata (HU-64.8).
  if (error instanceof BuyNowTransferNotFoundError) {
    return new NotFoundException(body(404, 'BUY_NOW_TRANSFER_NOT_FOUND', error.message))
  }
  if (
    error instanceof BuyNowTransferInsufficientBalanceError ||
    error instanceof BuyNowTransferSameAccountError ||
    error instanceof InvalidBuyNowTransferAmountError
  ) {
    return new UnprocessableEntityException(body(422, 'BUY_NOW_TRANSFER_INVALID', error.message))
  }

  // Apuestas (HU-23): cada rechazo terminal lleva su `code` del contrato §11.
  if (error instanceof InsufficientAvailableBalanceError) {
    return new UnprocessableEntityException(
      body(422, 'INSUFFICIENT_AVAILABLE_BALANCE', error.message),
    )
  }

  if (error instanceof HoldNotFoundError) {
    return new UnprocessableEntityException(body(422, 'HOLD_NOT_FOUND', error.message))
  }

  if (error instanceof SettlementNotZeroSumError) {
    return new UnprocessableEntityException(body(422, 'SETTLEMENT_NOT_ZERO_SUM', error.message))
  }

  if (error instanceof HoldAmountMismatchError) {
    return new UnprocessableEntityException(body(422, 'HOLD_AMOUNT_MISMATCH', error.message))
  }

  if (error instanceof InvalidStakeAmountError) {
    return new UnprocessableEntityException(body(422, 'INVALID_AMOUNT', error.message))
  }

  // HU-22: el unico DomainError que existia antes de HU-23 era el catalogo
  // cerrado de montos de recompensa.
  if (error instanceof DomainError) {
    return new UnprocessableEntityException(body(422, 'INVALID_REWARD_AMOUNT', error.message))
  }

  if (error instanceof HttpException) {
    return error
  }

  // Cualquier otro fallo (motor inalcanzable, timeout de conexion) es un 503:
  // no se traduce en un rechazo terminal ni en "0 creditos" (S3 del contrato).
  return new ServiceUnavailableException(
    body(
      503,
      'DEPENDENCY_UNAVAILABLE',
      'No se pudo procesar la operacion. Reintente el mismo operationId.',
    ),
  )
}
