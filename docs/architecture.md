# Arquitectura de Wallet

Fuente de la decisión: [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md).
Este documento describe lo **previsto**; los contratos exactos se publican como OpenAPI en `Nexus-Battle-Infrastructure/docs/contracts` antes de implementarse.

## Responsabilidad

Custodia el saldo de créditos de cada jugador y es la **única** fuente de verdad de cuánto tiene, cuánto está reservado y por qué cambió. Ningún otro servicio guarda ni calcula saldos.

## Datos que posee

- Saldo disponible y saldo reservado por jugador.
- Reservas con caducidad (`ACTIVE` → `CAPTURED` | `RELEASED` | `EXPIRED`).
- Libro de movimientos **insert-only**: cada cambio de saldo deja una entrada con su `operationId`.
- Cuentas de sistema para comisiones (por ejemplo, las de publicación de subastas).

Motor: **PostgreSQL**, base lógica `wallet` con usuario y credenciales propios en el nodo de datos.

## Invariantes que debe imponer el motor

- `CHECK (available >= 0)` y `CHECK (reserved >= 0)`: el motor rechaza un saldo negativo aunque el código falle.
- Importes `bigint` y estrictamente positivos: nunca coma flotante para dinero.
- `operation_id` único: reintentar con el mismo identificador devuelve el mismo resultado; reutilizarlo con otro cuerpo responde `409`.
- Las entradas del libro no se actualizan ni se borran.

## Integraciones

- **Entrada interna** (`/api/internal/v1/wallet/...`, HMAC): Auction, Combat y Missions reservan, capturan, liberan y acreditan.
- **Entrada pública** prevista: consulta del propio saldo con el `sub` del testimonio.
- **Salida:** ninguna. Wallet no llama a otros servicios.

Todas las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar en el dueño del recurso con ese `operationId`.
3. Capturar o liberar según el resultado del propio agregado.
4. Toda reserva nace con caducidad; `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Contrato previsto

- `POST /api/internal/v1/wallet/holds` — reservar `{operationId, playerId, amount, reason, reference, expiresAt}`.
- `POST /api/internal/v1/wallet/holds/{holdId}/captures` — capturar hacia un beneficiario o una cuenta de sistema.
- `POST /api/internal/v1/wallet/holds/{holdId}/releases` — liberar.
- `POST /api/internal/v1/wallet/credits` — acreditar recompensas.
- `GET /api/v1/wallet/me` — saldo propio.

## Temporizadores

Los vencimientos usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (`FOR UPDATE SKIP LOCKED`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. Mismo patrón que `AccountDeletionProcessingScheduler` en Account.

## Decisiones abiertas

- Cómo recibe un jugador sus primeros créditos: no hay Historia de Usuario que lo defina.
- Si Commerce comprará con créditos a través de este contrato (fuera de Sprint 2).
