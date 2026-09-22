import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { OperationConflictError } from '../../../application/errors/WalletPersistenceError'
import { DomainError } from '../../../domain/errors/DomainError'

const body = (statusCode: number, code: string, message: string): Record<string, unknown> => ({
  statusCode,
  code,
  message,
})

/** Semantica de codigos de HU-59/ADR-019, S3 del contrato HU-22. */
export const toWalletHttpException = (error: unknown): HttpException => {
  if (error instanceof OperationConflictError) {
    return new ConflictException(body(409, 'OPERATION_CONFLICT', error.message))
  }

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
