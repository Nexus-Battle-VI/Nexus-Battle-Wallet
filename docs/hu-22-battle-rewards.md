# HU-22 — Créditos de victoria y progreso de cofre (Wallet)

- **Task:** HU-22.2 ([Management #428](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/428)).
- **Historia:** [HU-22 #69](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69) · EPIC-06.
- **Contrato del que parte, sin reabrirlo:** [hu-22-reward-contract-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-22-reward-contract-v1.md) (Infrastructure, Task HU-22.1).
- **Aclaraciones funcionales del PO:** [Management #69](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69), comentarios del 2026-09-22.

## Qué implementa esta Task

Wallet pasa de andamiaje puro a tener sus **primeras rutas y tablas de negocio**:

- `POST /api/internal/v1/wallet/credits/battle-reward` (interno, HMAC, solo `combat`): acredita el derecho de HU-21 (`BattleCreditsPolicy`, ya calculado por Combat) y evalúa si corresponde cofre.
- `GET /api/v1/wallet/me` (público, JWT): saldo, progreso de victoria, contador semanal de cofres y umbral, para el jugador autenticado (`sub` del token, nunca un parámetro).

## Reglas aplicadas (sin inventar ninguna)

| Regla                                                                  | Fuente                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| Ganador 1v1 +2, ganador grupal +4, resto +1                            | HU-21 `BattleCreditsPolicy`, reutilizada tal cual |
| Solo los créditos de victoria alimentan el progreso                    | Management #69                                    |
| Umbral 20, cofre y progreso a 0 sin remanente                          | Management #69                                    |
| Máximo 2 cofres por semana                                             | Management #69                                    |
| Semana lunes 00:00 → domingo 23:59:59, `America/Bogota`                | Management #69, decisión del 2026-09-22           |
| Al llegar a 2/2, el progreso se congela en 0 hasta la semana siguiente | Management #69, decisión del 2026-09-22           |

`src/domain/policies/ChestEligibilityPolicy.ts` implementa la regla de progreso/cofre como función pura; `src/domain/value-objects/week-identity.ts` calcula la identidad de semana en `America/Bogota` con `Intl.DateTimeFormat` (sin aritmética de desfase a mano, y sin depender de la zona horaria del proceso).

## Modelo de datos (migración `001-wallet-accounts`)

- `wallet_accounts`: estado **actual** por jugador (`balance`, `victory_progress`, `weekly_chest_count`, `week_identity`). `CHECK` de no negatividad en los tres campos numéricos.
- `wallet_ledger`: **insert-only**. Cada fila guarda el movimiento _y_ el estado resultante completo (`resulting_*`, `chest_earned`), lo que permite responder un replay del mismo `operationId` sin volver a calcular nada. `operation_id` es `UNIQUE`: la base rechaza un duplicado incluso si la capa de aplicación tuviera un error.

## Idempotencia y concurrencia

Seguido el mismo patrón que `PostgresAuctionRepository` (Auction, Team Gama, mismo ADR-019):

1. `pg_advisory_xact_lock(hashtext(operationId))` serializa reintentos de la **misma** operación.
2. Si `operationId` ya existe: mismo cuerpo → replay (`applied:false`, mismo resultado); cuerpo distinto → `OperationConflictError` (`409`).
3. `pg_advisory_xact_lock(hashtext(playerId))` serializa operaciones **concurrentes** sobre la **misma** cuenta — sin esto, dos batallas del mismo jugador terminando casi a la vez podrían leer el mismo progreso y producir dos cofres cuando solo corresponde uno. Verificado con una prueba real de dos escrituras concurrentes contra PostgreSQL (`test/db/wallet-repository.spec.ts`).
4. `creditsAmount`/`victoryCreditsAmount` se revalidan contra el catálogo cerrado `{1,2,4}`/`{0,2,4}` en el dominio (`assertValidBattleRewardAmounts`), no solo en el DTO: Wallet no confía en que Combat mande el monto correcto.

## Rollover semanal (perezoso)

No hay cron. Al leer o escribir el estado de una cuenta, si la identidad de semana actual no coincide con la almacenada, `weekly_chest_count` vuelve a 0 antes de aplicar la operación (`computeNextWalletState`, compartida entre `PostgresWalletRepository` y `InMemoryWalletRepository` para que ambos adaptadores apliquen exactamente la misma regla). `victory_progress` **no** se reinicia por el rollover en sí: solo `ChestEligibilityPolicy` lo congela en 0 cuando ya se alcanzó el límite semanal.

## Fuera de alcance de esta Task

- Selección de la recompensa del cofre y su entrega a Player-Inventory: Combat (HU-22.3, [#429](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/429)).
- Presentación en Web: HU-22.5 ([#431](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/431)).
- HU-23 (apuesta), HU-30 (caída de ítems), HU-10 (recompensa de misión): no se tocan.

## Pruebas

- `test/unit/`: `week-identity`, `chest-eligibility-policy`, `battle-reward-amounts`, `credit-battle-reward` (con `InMemoryWalletRepository`), `get-wallet-snapshot`.
- `test/integration/wallet-http.spec.ts`: HTTP end-to-end con `PERSISTENCE_DRIVER=memory` — HMAC, allow-list, idempotencia, 422, JWT, aislamiento entre jugadores.
- `test/db/wallet-repository.spec.ts`: PostgreSQL real (Testcontainers) — constraint `UNIQUE`, umbral, **concurrencia real** con `Promise.all`, rollover semanal.
- Mutaciones verificadas manualmente y restauradas (remanente tras cofre, tercer cofre con `>` en vez de `>=`, bypass de la comprobación de idempotencia): las tres las detectan las pruebas existentes.
