# HU-84: cobro y compensación de inscripción en créditos

Implementación local del contrato `torneos-hu77-84-78-hu83-v2.0.0`, sección Wallet de `hu-77-84-tournament-registration-v2.md`.
Refs: Nexus-Battle-VI/Nexus-Battle-Management#468 y #467. El consumo en Tournament/Web y la aceptación integrada siguen pendientes.

## Rutas y autoridad

Solo el caller `tournament`, autenticado con el HMAC existente, puede acceder:

- `POST /api/internal/v1/wallet/tournament-entry-fees`: `{operationId,tournamentId,teamId,payerId,amount}`. Importe entero positivo seguro; identificadores no vacíos de hasta 200 caracteres.
- `POST /api/internal/v1/wallet/tournament-entry-fees/:chargeId/refunds`: `{operationId}`. Deriva pagador e importe del cobro persistido. Campos adicionales se rechazan.

El resultado conserva `{operationId,chargeId,tournamentId,teamId,payerId,amount,status,applied}`. El eco `operationId` identifica la petición de cobro o de devolución correspondiente; `chargeId` permanece estable. Tournament obtiene importe y creador pagador de su configuración/registro autorizado, valida toda la tupla devuelta y confirma el cupo. Una petición del navegador sin HMAC no autoriza un movimiento de créditos. Añadir `tournament` a la lista de callers no le permite usar las rutas de Auction, Combat o Missions.

Gratis y `SIMULATED_MONEY` no llaman estas rutas. Este incremento no implementa la pasarela, conversiones, cupos, cancelación de inscripciones confirmadas ni premios.

## Durabilidad y recuperación

Cada cobro descuenta únicamente `balance - reserved`. Transacciones y bloqueos sobre operación/cuenta protegen saldo, registro y ledger. Las operaciones de inscripción usan el mismo bloqueo de cuenta que las demás operaciones de Wallet. PostgreSQL calcula los saldos con aritmética `numeric` exacta, conservando medios créditos de la migración publicada `007` y sin convertirlos a `Number`.

Mismo ID/intención devuelve el cobro vigente con `applied:false`; cambiar torneo, equipo, pagador, importe o tipo de acción da `409 OPERATION_CONFLICT`. La compensación se abona una vez, incluso si llegan distintos IDs de devolución para el mismo cobro. Un cobro `REFUNDED` nunca se reactiva: repetir el cobro devuelve `REFUNDED` y no descuenta. El ledger admite un único movimiento por `(chargeId,kind)`.

Saldo insuficiente persiste `REJECTED` sin movimiento y responde `422 INSUFFICIENT_BALANCE`. El replay conserva ese rechazo incluso tras recargar saldo; otro intento necesita otro ID. Devolver un cobro inexistente o rechazado da `404 CHARGE_NOT_FOUND` sin abonar créditos. Errores HTTP de esquema son 400.

Timeout o `503 DEPENDENCY_UNAVAILABLE` representa incertidumbre. Se reintenta la misma intención con el mismo ID para recuperar el resultado durable; no se deduce rechazo ni se crea otro cobro. IDs coordinados: `entry:{teamId}:{operationId}:charge` y `entry:{teamId}:{operationId}:refund`. Una devolución recuperada conserva su propio ID y todos los datos originales del cobro. Tournament conserva el estado pendiente/reserva hasta comprobar el rechazo o la compensación según el contrato común.

## Migración y verificación

`008-wallet-tournament-entry-fees` añade las tablas de cobros, operaciones de devolución y ledger de inscripción. Conserva contenido/nombres de `001`–`007`, sus tablas y la devolución parcial de subastas. El ledger nuevo usa `numeric` para saldo resultante y `bigint` para la tarifa entera. Ejecutar `npm run build` y después `npm run migrate` como paso explícito; el arranque no migra.

Pruebas dedicadas:

- `test/unit/tournament-entry-fees.spec.ts`: saldo, reservas, replay, conflictos, validaciones y ledger en el doble.
- `test/integration/wallet-tournament-entry-fees-http.spec.ts`: HTTP, tupla/eco, HMAC, permisos por ruta y errores.
- `test/db/postgres-tournament-entry-fee-repository.spec.ts`: concurrencia entre pools, rechazo persistente, medios créditos, saldos grandes exactos, invariantes del motor y rollback ante fallo inducido del ledger.
- `test/db/wallet-tournament-entry-fees-http.spec.ts`: aplicación NestJS y PostgreSQL reales, respuestas 503 inducidas después del commit, nuevos arranques y recuperación sin movimientos duplicados.
- `test/db/wallet-tournament-entry-fee-migration.spec.ts`: actualización desde `001`–`007` con datos de prueba, saldos/ledger históricos y devolución parcial conservados, reconexión sin reaplicar migraciones y reversión únicamente de tablas nuevas.

Las suites DB usan PostgreSQL 17/Testcontainers por defecto. `TEST_DATABASE_URL` habilita un motor local con una base desechable por suite; requiere permiso de creación. Los importes 100 y saldos 120/99 son escenarios de prueba de HU-84. Las pruebas de Wallet no acreditan cupos, sesiones Cognito reales, aceptación funcional, despliegue ni cierre de HU-84.
