# Nexus-Battle-Wallet

Servicio de Nexus Battles VI para el bounded context **Wallet**: saldos de créditos, reservas y libro de movimientos.

Custodia el saldo de créditos de cada jugador y es la **única** fuente de verdad de cuánto tiene, cuánto está reservado y por qué cambió. Ningún otro servicio guarda ni calcula saldos.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Decisión que lo crea:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (`Accepted`)
- **Épicas:** [EPIC-07 Subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/7), [EPIC-06 Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6), [EPIC-08 Misiones](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/8)
- **Team propietario:** Team Gama
- **Arquitectura interna:** Clean + Hexagonal ([ADR-002](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-002-backend-stack.md))
- **Base de datos:** PostgreSQL, propia y exclusiva ([ADR-005](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-005-data-strategy.md))
- **Puerto:** 3009

## Estado

**Andamiaje desplegado.** Desde el 2026-09-16 corre en producción en el nodo `app` y Caddy le envía `https://nexus.simuladorupbbga.app/api/v1/wallet*`. Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base, que ya existe con usuario propio.

**No tiene todavía ninguna ruta de negocio ni ninguna tabla o colección**: las añade cada Historia de Usuario. Mientras tanto, cualquier ruta bajo ese prefijo responde `404` desde NestJS.

## Qué posee este contexto

- Saldo disponible y saldo reservado por jugador.
- Reservas con caducidad (`ACTIVE` → `CAPTURED` | `RELEASED` | `EXPIRED`).
- Libro de movimientos **insert-only**: cada cambio de saldo deja una entrada con su `operationId`.
- Cuentas de sistema para comisiones (por ejemplo, las de publicación de subastas).

Ningún otro servicio accede a este almacén, ni directamente ni con claves foráneas.

## Historias de Usuario que viven aquí

| HU    | Historia                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| HU-62 | [Comisión de publicación en subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/47)        |
| HU-63 | [Reserva y liberación de créditos por puja](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/48) |
| HU-65 | [Liquidación de créditos al vendedor](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/50)       |
| HU-23 | [Apuesta de créditos en batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/70)            |
| HU-22 | [Cofre por acumulación de créditos](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69)         |
| HU-10 | [Recompensas en créditos por misión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/19)        |

## Integraciones previstas

- **Entrada interna** (`/api/internal/v1/wallet/...`, HMAC): Auction, Combat y Missions reservan, capturan, liberan y acreditan.
- **Entrada pública** prevista: consulta del propio saldo con el `sub` del testimonio.
- **Salida:** ninguna. Wallet no llama a otros servicios.

Detalle en [docs/architecture.md](docs/architecture.md).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
    outbound/        Persistencia, identidad, clientes de otros servicios
  infrastructure/    config, observabilidad, salud, persistencia y composición
```

El dominio no importa NestJS, drivers ni adaptadores, y la aplicación depende solo de sus puertos: lo impide ESLint en CI. Los casos de uso son clases sin decoradores registradas con fábricas en `src/infrastructure/bootstrap/app.module.ts`.

## Verificación local

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:db        # requiere Docker: levanta PostgreSQL con Testcontainers
npm run build
```

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                             | Resultado                |
| ----------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`        | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory` | **No arranca** (ADR-019) |
| `PERSISTENCE_DRIVER=postgres` sin `DATABASE_URL`      | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                    | **No arranca**           |

## Identidad y autorización

- **Toda ruta nace protegida.** El guard es global; abrir una ruta exige `@Public()`.
- La identidad sale del token de acceso verificado contra el JWKS del pool (`aws-jwt-verify`), nunca del cuerpo ni de la URL.
- `@Roles(...)` restringe por rol; `SUPER_ADMINISTRATOR` satisface lo que se exige a `ADMINISTRATOR`, y no al revés.
- Las rutas `@InternalOnly()` exigen firma HMAC-SHA256 (`x-internal-service`, `x-internal-timestamp`, `x-internal-signature`) de un servicio de la lista `INTERNAL_CALLERS`. Sin secreto configurado responden `503`. Caddy bloquea `/api/internal*` desde fuera.

## Sondas

| Ruta                    | Semántica                                     |
| ----------------------- | --------------------------------------------- |
| `GET /api/health/live`  | El proceso responde. No consulta dependencias |
| `GET /api/health/ready` | Hace ping a PostgreSQL. `503` si no responde  |
| `GET /api/version`      | Servicio, versión y entorno                   |

## Ramas

`main` y `develop` están protegidas. Todo Pull Request va a **`develop`**; `main` solo recibe la promoción completa de `develop`, y el workflow `Flujo de ramas` lo hace cumplir. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Licensing pending project governance.
