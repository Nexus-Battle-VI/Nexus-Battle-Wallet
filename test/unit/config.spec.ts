import {
  ConfigurationError,
  loadConfig,
  PersistenceDriver,
} from '../../src/infrastructure/config/env'

describe('Configuracion del servicio', () => {
  it('arranca con valores por defecto de desarrollo', () => {
    const config = loadConfig({})

    expect(config).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-wallet',
      port: 3009,
      globalPrefix: 'api',
      swaggerEnabled: true,
      persistenceDriver: PersistenceDriver.Memory,
      databaseUrl: null,
      internalServiceAuthSecret: null,
    })
  })

  it('lee los valores declarados en el entorno', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      SERVICE_NAME: 'otro-nombre',
      SERVICE_VERSION: '9.9.9',
      LOG_LEVEL: 'debug',
      PORT: '4000',
      GLOBAL_PREFIX: 'prefijo',
      SWAGGER_ENABLED: 'false',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://usuario@db/wallet',
      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',
    })

    expect(config).toMatchObject({
      nodeEnv: 'test',
      serviceName: 'otro-nombre',
      version: '9.9.9',
      logLevel: 'debug',
      port: 4000,
      globalPrefix: 'prefijo',
      swaggerEnabled: false,
      persistenceDriver: PersistenceDriver.Postgres,
      databaseUrl: 'postgres://usuario@db/wallet',
      internalServiceAuthSecret: 'secreto',
    })
  })

  it('deshabilita la documentacion interactiva en produccion por defecto', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://db/wallet',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_abc',
      COGNITO_CLIENT_ID: 'cliente',
    })

    expect(config.swaggerEnabled).toBe(false)
  })

  it('exige DATABASE_URL con el driver de PostgreSQL', () => {
    expect(() => loadConfig({ PERSISTENCE_DRIVER: 'postgres' })).toThrow(/DATABASE_URL/)
  })

  /**
   * Un saldo que desaparece al reiniciar no es un saldo. El control es la
   * prueba anterior de produccion completa: con PostgreSQL si arranca.
   */
  it('impide arrancar en produccion con persistencia en memoria', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_abc',
        COGNITO_CLIENT_ID: 'cliente',
      }),
    ).toThrow(/PERSISTENCE_DRIVER/)
  })

  it.each([
    ['un entorno desconocido', { NODE_ENV: 'staging' }],
    ['un driver desconocido', { PERSISTENCE_DRIVER: 'mongo' }],
    ['un puerto no entero', { PORT: 'tres mil' }],
    ['un puerto fuera de rango', { PORT: '70000' }],
    ['un booleano ambiguo', { SWAGGER_ENABLED: 'si' }],
    ['un nivel de registro desconocido', { LOG_LEVEL: 'trace' }],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })

  it('configura los limites de Auction y rechaza enteros invalidos', () => {
    expect(loadConfig({}).auctionHoldGraceMs).toBe(300000)
    expect(loadConfig({}).auctionMaxCloseAheadMs).toBe(172800000)
    expect(
      loadConfig({ AUCTION_HOLD_GRACE_MS: '123', AUCTION_MAX_CLOSE_AHEAD_MS: '456' }),
    ).toMatchObject({ auctionHoldGraceMs: 123, auctionMaxCloseAheadMs: 456 })
    for (const value of ['0', '-1', 'texto', '1.5']) {
      expect(() => loadConfig({ AUCTION_HOLD_GRACE_MS: value })).toThrow(ConfigurationError)
      expect(() => loadConfig({ AUCTION_MAX_CLOSE_AHEAD_MS: value })).toThrow(ConfigurationError)
    }
  })
})
