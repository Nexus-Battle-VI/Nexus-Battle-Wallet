# HU-86 — Créditos de premio en Wallet

Implementación aditiva, con padre Wallet PR #29 (`90faf19bc28c0a9f929d7c77aae192c1b3a99642`).
Refs Nexus-Battle-VI/Nexus-Battle-Management#472, #493, #494, #496.
Contrato consumido: `torneos-cierre-v0.1.0-propuesta`, Infrastructure
`a5cdcc5c9f610d0ee7eaa4ab57b224ea34a4966b`, `torneos-cierre-premios-v0.1.0.md`
SHA-256 `cbc0c4f5094dc443132fe7ea546d55cee0343191bcf1ef7cb85b61bdcf09677e`.
Acuse propio en `estado/chat-03.json`; no congela el acuerdo ni acredita aceptación funcional.
Registro/fees mantienen `torneos-hu77-84-78-hu83-v2.0.0`.

## Autoridad y referencias

Tournament posee campeón, final, configuración aprobada y destinatarios. Wallet recibe
el derecho firmado y valida sus campos y representación; no consulta bases ajenas.
`playerId` identifica la única cuenta de Wallet. Como las recompensas existentes,
se crea una cuenta en cero si aún no existe: su ausencia no demuestra un jugador
inválido. Wallet no tiene un puerto para consultar propiedad de héroes o finales.
Tournament debe validar esas referencias contra su fuente autoritativa antes de
emitir el derecho. `heroId`, campeón y final dan trazabilidad y también forman parte
del propósito: modificarlos en un replay causa conflicto.

No se aplica la política HU-22 de batallas/victorias/cofres ni se reinicia la semana.
No se implementan HU-85, elección de campeón, reglas de motor ni reparto.

## HTTP y representación

`POST /api/internal/v1/wallet/credits/tournament-prize`. Solo HMAC del consumidor
`tournament`, permitido por la ruta y por la lista global. Firma, JSON canónico,
cabeceras, método, ruta sin query y ventana temporal son los existentes.
JWT público o HMAC válido de Combat/Missions/Auction no autorizan la ruta.

Los diez campos son obligatorios y se rechazan campos desconocidos:

```json
{
  "operationId": "tournament:qa-hu86:prize:0:CREDITS",
  "tournamentId": "qa-hu86",
  "championTeamId": "qa-team",
  "finalEncounterId": "qa-final-opaque-id",
  "finalRoomId": "qa-room",
  "playerId": "qa-player",
  "heroId": "qa-hero",
  "kind": "CREDITS",
  "amount": "501",
  "productId": null
}
```

Ejemplo QA, sin campeón real ni política operativa aprobada. Referencias string
de 1–160 caracteres; `operationId` y `finalEncounterId` hasta 512. Se rechazan
espacios iniciales/finales, referencias vacías y NUL incompatible con PostgreSQL;
no se recortan ids. `amount` es string canónico `1..9007199254740991`, sin signo,
ceros iniciales, exponente, espacios o fracciones. Validación con BigInt, suma
PostgreSQL `numeric` y parámetros string: ningún importe de premio pasa por float.
Los medios créditos del saldo, reservas y devoluciones publicados se conservan.

Primera entrega y replay devuelven **200** con los diez campos persistidos,
`status:"DELIVERED"` y `receiptId` UUID estable, sin atributos añadidos al contrato.
El saldo exacto aplicado está en el ledger junto al recibo; un replay no lo calcula
con el saldo actual. No se requiere una segunda ruta de consulta para recuperarlo.
OpenAPI se genera de los DTO/controlador reales en `/api/docs` cuando está habilitado.

| HTTP | Código                         | Situación                                                                |
| ---- | ------------------------------ | ------------------------------------------------------------------------ |
| 400  | `SCHEMA_INVALID`               | Tipo/campo desconocido, referencia mal formada, kind/productId inválidos |
| 401  | Guard HMAC existente           | Identidad, firma, caller o timestamp inválidos                           |
| 409  | `OPERATION_ID_REUSED`          | Mismo id de Tournament con otro propósito o derecho                      |
| 422  | `PRIZE_INVALID`                | String de importe no canónico, no positivo o fuera de rango              |
| 503  | `PRIZE_DEPENDENCY_UNAVAILABLE` | PostgreSQL no disponible o driver memory                                 |
| 503  | Guard HMAC existente           | Falta el secreto interno; el guard deniega antes del controlador         |

Errores de aplicación usan `{statusCode,code,message}`. 401 y falta de secreto
conservan el envoltorio Nest del guard HMAC existente, sin cambiar contratos ajenos;
Tournament consume esos rechazos por HTTP status. Un timeout/503 no demuestra que
no hubo movimiento: repetir exactamente el mismo derecho.

## Persistencia e idempotencia

Reserva de Coordinación: **009-wallet-tournament-prizes**, posterior a 008 de fees.
No modifica/renombra 001–008, ni recrea cuentas, ni convierte `numeric` a entero.

`wallet_tournament_operation_ids` tiene PK `operation_id` dentro del consumidor
Tournament; sus únicos propósitos son `ENTRY_CHARGE`, `ENTRY_REFUND`, `PRIZE_CREDITS`.
Los demás consumidores conservan sus espacios/contratos existentes. Todas las
rutas actualmente autorizadas a Tournament son inscripción/devolución y premio.
La migración carga los ids históricos, incluidos rechazos y devoluciones; el código
HU-84 actual reclama el mismo registro antes de tocar la cuenta. Conserva su
`OPERATION_CONFLICT` existente al rechazar colisiones. Una ruta futura de Tournament
debe incorporarse a este registro, no abrir otro espacio de idempotencia.

Una transacción reclama id/purpose antes de locks de cuenta. La PK de PostgreSQL
serializa llamadas de procesos/pools distintos. Mismo propósito de premio compara
todos los campos persistidos; otro propósito devuelve conflicto. El crédito exacto
en `wallet_accounts` y la única fila de `wallet_tournament_prize_ledger` se confirman
en el mismo commit. La fila contiene derecho, monto, saldos aplicados, fecha y UUID
de recibo, con PK/FK, restricciones y trigger contra UPDATE/DELETE. No hay otro saldo
ni un recibo que pueda confirmarse separado del movimiento. Un fallo revierte también
la reserva del id y la cuenta nueva. Desplegar la migración y el código HU-84/86
compatibles juntos; una instancia antigua no participa en el registro nuevo.

`down` elimina únicamente estas estructuras; no reembolsa créditos confirmados y
elimina trazabilidad del premio. No es un mecanismo operativo de compensación.

La ruta exige PostgreSQL incluso en desarrollo: `memory` responde 503 para no
confirmar un premio que desaparecería al reiniciar. No se necesita otra clave de
entorno: `DATABASE_URL`, `PERSISTENCE_DRIVER` e `INTERNAL_SERVICE_AUTH_SECRET` existentes.

## Verificación y límites

Tests propios bajo `test/{unit,integration,db}`: DTO estricto/HMAC; importes exactos
incluidos saldos superiores a 2^53 con fracción; ledger vinculado; replay, dos pools,
solicitudes HTTP concurrentes y recreación de app/pool; socket cancelado tras commit;
conflictos por importe/jugador/héroe/campeón/final; rollback de fallo inyectado de
ledger; colisiones con fees/refunds y carrera de propósitos; upgrade desde 008 con
datos y devoluciones fraccionarias preservados. La suite completa cubre además
las recompensas, apuestas, subastas y HU-84 previas.

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage -- --runInBand
npm run test:db -- --runInBand
npm run build
```

`test:db` usa PostgreSQL real vía Testcontainers; opcionalmente `TEST_DATABASE_URL`
apunta a un servidor QA con permiso CREATE DATABASE. Cada suite crea y elimina su
propia base aleatoria; nunca prueba sobre la base administrativa indicada.
El harness externo de Chat03 fija y transpila el cliente real de Tournament por SHA,
sin escribir en ese checkout, para comprobar HTTP/HMAC y validación de recibo sobre
un derecho QA. Esta prueba del destino no demuestra un torneo jugado.

Aceptar HU-86 requiere repetir con HU-85/HU-80 reales, campeón confirmado y política
G2/catálogo aprobados. No hay autorización de publicación remota, merge, despliegue
ni cierre de HU en este encargo. Tras integrar/squash del padre #29, Coordinación
debe adaptar solo este incremento a develop y verificar el SHA resultante.

## Bloqueos heredados de precisión verificados

El usuario confirmó conservar el alcance HU-86 y entregar estos bloqueos a
Coordinación, sin ampliar ahora a las operaciones antiguas. Los dos archivos
implicados mantienen los bytes del padre #29. Diagnóstico en el harness QA externo
`diagnose-legacy-precision.cjs`, resultado `legacy-precision-diagnostics.json`.

- **WALLET-PRECISION-01:** después de acreditar exactamente un premio QA 501,
  el saldo SQL `9007199254741492.5` recibe una recompensa HU-22 de 2. Debería quedar
  `9007199254741494.5`; queda `9007199254741494`. El repositorio heredado de batallas
  convierte el saldo a Number antes de escribir. El handler HU-86 conserva la
  fracción; una operación posterior la pierde. GET /wallet/me también usa Number.
- **WALLET-PRECISION-02:** una cuenta SQL con `100.5` recibe una recompensa de
  misión de 1. Debería quedar `101.5`; el repositorio heredado rechaza con
  `InvalidMissionRewardAmountError` por `Number.isSafeInteger(balance)`. Además,
  su ledger declara `resulting_balance bigint` desde 006.

Las suites de regresión existentes pasan, pero no cubren esas interacciones.
El diagnóstico reproducible demuestra ambos defectos y bloquea la certificación
de compatibilidad completa de Wallet; no se presentan como corregidos. No se
imponen límites nuevos al premio para ocultarlos ni se convierte el saldo a entero.
Coordinación debe acordar la corrección de aritmética y representación en las
capacidades heredadas (también revisar holds/transferencias/comisiones que usan
Number) o revisar el contrato de rango, con una migración adicional reservada si
corresponde. **Veredicto de este incremento: revisión local; integración técnica
completa y aceptación funcional pendientes.**
