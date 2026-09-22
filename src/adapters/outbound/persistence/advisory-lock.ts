import { sql, type Transaction } from 'kysely'

import type { Database } from './schema'

/**
 * Serializa operaciones sobre el mismo recurso dentro de una transaccion.
 *
 * `pg_advisory_xact_lock(hashtext(...))` se libera solo al terminar la
 * transaccion. Wallet lo usa con dos propositos (ADR-019, HU-22/HU-23):
 * serializar reintentos de la MISMA operacion (`operationId`) y serializar
 * operaciones CONCURRENTES sobre la MISMA cuenta (`playerId`). Vive en un
 * unico sitio para que los dos repositorios de persistencia no puedan
 * divergir en la forma de tomarlo.
 */
export const lockByText = async (
  transaction: Transaction<Database>,
  value: string,
): Promise<void> => {
  await sql`select pg_advisory_xact_lock(hashtext(${value}))`.execute(transaction)
}
