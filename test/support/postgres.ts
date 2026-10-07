import { randomUUID } from 'node:crypto'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'

/** Cada suite recibe una base nueva; TEST_DATABASE_URL nunca es la base bajo prueba. */
export const startTestPostgres = async (): Promise<{
  connectionString: string
  stop: () => Promise<void>
}> => {
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) {
    const container = await new PostgreSqlContainer('postgres:17-alpine').start()
    return {
      connectionString: container.getConnectionUri(),
      stop: async () => {
        await container.stop()
      },
    }
  }

  const name = `wallet_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: configured })
  await admin.connect()
  try {
    // name solo contiene el prefijo constante y un UUID hex generado aquí.
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(configured)
    url.pathname = `/${name}`
    return {
      connectionString: url.toString(),
      stop: async () => {
        try {
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
        } finally {
          await admin.end()
        }
      },
    }
  } catch (error: unknown) {
    await admin.end()
    throw error
  }
}
