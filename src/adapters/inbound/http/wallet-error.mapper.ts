import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'

import {
  CapturedWithoutHoldError,
  HoldAmountMismatchError,
  HoldNotFoundError,
  InsufficientAvailableBalanceError,
  SettlementNotZeroSumError,
} from '../../../application/errors/StakePersistenceError'
import {
  AuctionHoldAlreadyCapturedError,
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
import {
  InvalidMissionRewardAmountError,
  MissionRewardSchemaError,
} from '../../../application/errors/MissionRewardError'
import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import {
  InvalidTournamentEntryFeeAmountError,
  TournamentEntryFeeInsufficientBalanceError,
  TournamentEntryFeeNotFoundError,
} from '../../../application/errors/TournamentEntryFeeError'
import { DomainError } from '../../../domain/errors/DomainError'
import { InvalidStakeAmountError } from '../../../domain/value-objects/stake-amount'
import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
  AuctionPublicationFeeRefundExceedsChargeError,
  InvalidAuctionPublicationFeeAmountError,
  InvalidAuctionPublicationFeeRefundAmountError,
} from '../../../application/errors/AuctionPublicationFeeError'

const body = (statusCode: number, code: string, message: string): Record<string, unknown> => ({
  statusCode,
  code,
  message,
})

/** Semantica de codigos de HU-59/ADR-019, S3 de HU-22 y §11 de HU-23. */
export const toWalletHttpException = (error: unknown): HttpException => {
  if (error instanceof TournamentEntryFeeInsufficientBalanceError) {
    return new UnprocessableEntityException(body(422, 'INSUFFICIENT_BALANCE', error.message))
  }
  if (error instanceof InvalidTournamentEntryFeeAmountError) {
    return new BadRequestException(body(400, 'SCHEMA_INVALID', error.message))
  }
  if (error instanceof TournamentEntryFeeNotFoundError) {
    return new NotFoundException(body(404, 'CHARGE_NOT_FOUND', error.message))
  }
  // Credito de mision (HU-10.3): cuerpo fuera del contrato -> 400; importe que
  // incumple una regla -> 422. Cada uno con su `code` del contrato.
  if (error instanceof MissionRewardSchemaError) {
    return new BadRequestException(body(400, 'SCHEMA_INVALID', error.message))
  }
  if (error instanceof InvalidMissionRewardAmountError) {
    return new UnprocessableEntityException(body(422, 'MISSION_REWARD_INVALID', error.message))
  }
  if (error instanceof OperationConflictError) {
    return new ConflictException(body(409, 'OPERATION_CONFLICT', error.message))
  }
  if (error instanceof AuctionPublicationFeeNotFoundError)
    return new NotFoundException(body(404, 'PUBLICATION_FEE_NOT_FOUND', error.message))
  if (
    error instanceof AuctionPublicationFeeInsufficientBalanceError ||
    error instanceof InvalidAuctionPublicationFeeAmountError ||
    error instanceof InvalidAuctionPublicationFeeRefundAmountError ||
    error instanceof AuctionPublicationFeeRefundExceedsChargeError
  )
    return new UnprocessableEntityException(body(422, 'PUBLICATION_FEE_INVALID', error.message))
  if (error instanceof AuctionHoldNotFoundError)
    return new NotFoundException(body(404, 'HOLD_NOT_FOUND', error.message))
  // Codigo propio, no AUCTION_HOLD_INVALID: el consumidor debe poder
  // distinguir "ya capturado" (los creditos no volvieron) de cualquier otro
  // rechazo, sin interpretar el mensaje.
  if (error instanceof AuctionHoldAlreadyCapturedError)
    return new UnprocessableEntityException(
      body(422, 'AUCTION_HOLD_ALREADY_CAPTURED', error.message),
    )
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

  if (error instanceof CapturedWithoutHoldError) {
    return new UnprocessableEntityException(body(422, 'CAPTURED_WITHOUT_HOLD', error.message))
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
