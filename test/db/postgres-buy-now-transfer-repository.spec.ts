import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  BuyNowTransferInsufficientBalanceError,
  BuyNowTransferNotFoundError,
} from '../../src/application/errors/BuyNowTransferError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { PostgresBuyNowTransferRepository } from '../../src/adapters/outbound/persistence/PostgresBuyNowTransferRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('PostgresBuyNowTransferRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let transfers: PostgresBuyNowTransferRepository
  const now = new Date('2026-09-23T15:00:00.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    transfers = new PostgresBuyNowTransferRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seed = async (id: string, balance: number, reserved = 0): Promise<void> => {
    await sql`insert into wallet_accounts (player_id,balance,reserved,week_identity) values (${id},${balance},${reserved},'2026-09-21')`.execute(
      db,
    )
  }
  const row = async (id: string) =>
    (
      await sql<{
        balance: string
        reserved: string
      }>`select balance,reserved from wallet_accounts where player_id=${id}`.execute(db)
    ).rows[0]

  it('migracion 004 crea las tablas y aplica sus restricciones', async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_name in ('wallet_buy_now_transfers','wallet_buy_now_transfer_operations','wallet_buy_now_transfer_ledger')
    `.execute(db)
    expect(tables.rows).toHaveLength(3)

    await expect(
      sql`insert into wallet_buy_now_transfers (id,buyer_id,seller_id,amount,status,created_at,updated_at) values ('bad','p','p',10,'APPLIED',${now},${now})`.execute(
        db,
      ),
    ).rejects.toThrow()
  })

  it('transfiere, replica el reintento con el mismo operationId y revierte', async () => {
    await seed('comprador-db', 5000)
    await seed('vendedor-db', 1000)

    const first = await transfers.transfer({
      operationId: 'txn-db-1',
      buyerId: 'comprador-db',
      sellerId: 'vendedor-db',
      amount: 2500,
      now,
    })
    expect(first).toMatchObject({ transferId: 'txn-db-1', status: 'APPLIED', applied: true })
    expect(await row('comprador-db')).toMatchObject({ balance: '2500' })
    expect(await row('vendedor-db')).toMatchObject({ balance: '3500' })

    const replay = await transfers.transfer({
      operationId: 'txn-db-1',
      buyerId: 'comprador-db',
      sellerId: 'vendedor-db',
      amount: 2500,
      now,
    })
    expect(replay.applied).toBe(false)
    expect(await row('comprador-db')).toMatchObject({ balance: '2500' })

    await expect(
      transfers.transfer({
        operationId: 'txn-db-1',
        buyerId: 'comprador-db',
        sellerId: 'vendedor-db',
        amount: 999,
        now,
      }),
    ).rejects.toBeInstanceOf(OperationConflictError)

    const reversed = await transfers.reverse({
      operationId: 'reverse-db-1',
      transferId: 'txn-db-1',
      now,
    })
    expect(reversed).toMatchObject({ status: 'REVERSED', applied: true })
    expect(await row('comprador-db')).toMatchObject({ balance: '5000' })
    expect(await row('vendedor-db')).toMatchObject({ balance: '1000' })

    const reverseAgain = await transfers.reverse({
      operationId: 'reverse-db-2',
      transferId: 'txn-db-1',
      now,
    })
    expect(reverseAgain).toMatchObject({ status: 'REVERSED', applied: false })
    expect(await row('comprador-db')).toMatchObject({ balance: '5000' })
  })

  it('rechaza con saldo insuficiente respetando lo ya reservado', async () => {
    await seed('comprador-reservado', 1000, 800)
    await seed('vendedor-reservado', 0)

    await expect(
      transfers.transfer({
        operationId: 'txn-db-2',
        buyerId: 'comprador-reservado',
        sellerId: 'vendedor-reservado',
        amount: 500,
        now,
      }),
    ).rejects.toBeInstanceOf(BuyNowTransferInsufficientBalanceError)
    expect(await row('comprador-reservado')).toMatchObject({ balance: '1000', reserved: '800' })
  })

  it('rechaza revertir una transferencia que no existe', async () => {
    await expect(
      transfers.reverse({ operationId: 'x', transferId: 'no-existe', now }),
    ).rejects.toBeInstanceOf(BuyNowTransferNotFoundError)
  })

  it('deja auditoria completa en el ledger de compra inmediata', async () => {
    await seed('comprador-ledger', 5000)
    await seed('vendedor-ledger', 0)

    await transfers.transfer({
      operationId: 'txn-db-ledger',
      buyerId: 'comprador-ledger',
      sellerId: 'vendedor-ledger',
      amount: 1000,
      now,
    })
    await transfers.reverse({
      operationId: 'reverse-db-ledger',
      transferId: 'txn-db-ledger',
      now,
    })

    const entries = await sql<{ kind: string; player_id: string }>`
      select kind, player_id from wallet_buy_now_transfer_ledger
      where transfer_id = 'txn-db-ledger' order by id
    `.execute(db)

    expect(entries.rows.map((entry) => entry.kind)).toEqual([
      'BUY_NOW_DEBIT',
      'BUY_NOW_CREDIT',
      'BUY_NOW_REVERSAL_CREDIT',
      'BUY_NOW_REVERSAL_DEBIT',
    ])
  })
})
