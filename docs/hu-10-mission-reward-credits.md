# HU-10 — Créditos de finalización de misión (Wallet)

Wallet es la única autoridad del saldo y del ledger de créditos. Missions le pide acreditar los créditos de finalización de una misión por una operación **propia y distinta** de la de batalla de HU-22. El contrato completo vive en Infrastructure y **no se duplica aquí**: [`hu-10-mission-completion-reward-v1` §9](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-10-mission-completion-reward-v1.md).

## Qué implementa

- `POST /api/internal/v1/wallet/credits/mission-reward` (interno, HMAC, **solo `missions`**): acredita `creditsAmount` al saldo de `playerId`, una sola vez por `operationId`.
- Cuerpo (contrato §9.2): `schemaVersion` (`1`), `operationId` (`mission:{enrollmentId}:reward:{rewardKey}`), `playerId`, `reason` (`MISSION_REWARD`), `enrollmentId`, `missionId`, `difficulty`, `rewardKey` (`guaranteed|objective-bonus|first-time:{key}`), `creditsAmount` y `occurredAt`.
- Respuesta: `{ operationId, applied, balance }`. **Nada** de `victoryProgress`, `weeklyChestCount`, `weeklyChestLimit`, `weekIdentity` ni `chestEarned`.
- `occurredAt` es el `settledAt` **congelado** de Missions: forma parte del contenido que se compara en un reintento, así que Wallet no lo sustituye por su reloj.

## Wallet no decide cuánto vale una misión

Valida solo la **forma**: entero `>= 1` dentro del rango seguro del saldo (`bigint`). No hay catálogo `{1, 2, 4}`, ni tabla por dificultad, ni consulta a Missions. `difficulty` se valida por su vocabulario cerrado (HU-75) como forma; no se usa para calcular nada.

## Aislamiento de HU-22

Una misión **no es una victoria JcJ**. La operación incrementa **solo `balance`**: no lee ni escribe `victory_progress`, `weekly_chest_count`, `week_identity` ni `reserved` de una cuenta existente, y no evalúa cofre ni hace rollover semanal. Una cuenta que no existe nace en cero (`week_identity` es `NOT NULL`, así que recibe la semana actual; es la única vez que se escribe).

## Persistencia (migración `006-wallet-mission-reward-credits`)

`wallet_mission_reward_credits`: ledger **propio**, `operation_id` único, `(enrollment_id, reward_key)` único, importes `bigint`, restricciones (`credits_amount >= 1`, `reason = 'MISSION_REWARD'`, dificultad del vocabulario) y **trigger insert-only** (rechaza `UPDATE` y `DELETE`). No se reutiliza `wallet_ledger` (tiene `battle_id`, columnas de victoria y `chest_earned`) y no se migra ningún asiento de HU-22.

Saldo y asiento cambian en **una sola transacción**, con el patrón de idempotencia de Wallet (`pg_advisory_xact_lock` sobre `operationId` y sobre `playerId`).

## Idempotencia y códigos

| Caso                                                                                                                      | Resultado                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Primera aplicación                                                                                                        | `200`, `applied: true`                                                   |
| Mismo `operationId` + mismo contenido                                                                                     | `200`, `applied: false`, el `balance` **original**, sin sumar            |
| Mismo `operationId` + contenido distinto (importe, jugador, misión, dificultad, `occurredAt`…)                            | `409 OPERATION_CONFLICT`, sin sobrescribir                               |
| Importe no entero, `< 1` o fuera del rango seguro                                                                         | `422 MISSION_REWARD_INVALID`                                             |
| Cuerpo fuera del contrato (`schemaVersion`, `reason`, `operationId` que no corresponde a la matrícula y la línea, tipos…) | `400 SCHEMA_INVALID`                                                     |
| Sin firma, firma inválida, sello vencido, servicio no autorizado                                                          | `401`                                                                    |
| Sin secreto configurado                                                                                                   | `503` (falla cerrado)                                                    |
| Persistencia no disponible                                                                                                | `503 DEPENDENCY_UNAVAILABLE` (reintentar con el **mismo** `operationId`) |

## Autorización por ruta

| Ruta                                              | Servicio permitido  |
| ------------------------------------------------- | ------------------- |
| `POST /internal/v1/wallet/credits/mission-reward` | **solo `missions`** |
| `POST /internal/v1/wallet/credits/battle-reward`  | **solo `combat`**   |

`battle-reward` usaba `@InternalOnly()` sin lista: su comentario decía «solo combat» pero, con la lista global (`auction`, `combat`, `missions`), el guard admitía también a `missions` y `auction` (hallazgo de HU-10.1). Ahora se acota a `combat`.
