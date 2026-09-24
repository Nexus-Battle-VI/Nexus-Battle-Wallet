import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
  InvalidAuctionPublicationFeeAmountError,
} from '../../src/application/errors/AuctionPublicationFeeError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { AuctionPublicationFees } from '../../src/application/use-cases/AuctionPublicationFees'
import { InMemoryAuctionPublicationFeeRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPublicationFeeRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'
const now = new Date('2026-09-24T00:00:00.000Z')
const setup = (balance = 10, reserved = 0) => {
  const store = new InMemoryWalletStore()
  store.accounts.set('seller', {
    balance,
    reserved,
    victoryProgress: 3,
    weeklyChestCount: 1,
    weekIdentity: '2026-W39',
  })
  return {
    store,
    fees: new AuctionPublicationFees(new InMemoryAuctionPublicationFeeRepository(store), {
      now: () => now,
    }),
  }
}
describe('AuctionPublicationFees', () => {
  it('charge/refund restaura balance sin tocar reserved ni progreso', async () => {
    const { store, fees } = setup()
    await expect(
      fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 }),
    ).resolves.toMatchObject({ status: 'CHARGED', applied: true })
    expect(store.accounts.get('seller')).toMatchObject({
      balance: 7,
      reserved: 0,
      victoryProgress: 3,
    })
    await expect(fees.refund({ operationId: 'refund', chargeId: 'charge' })).resolves.toMatchObject(
      { status: 'REFUNDED', applied: true },
    )
    expect(store.accounts.get('seller')).toMatchObject({ balance: 10, reserved: 0 })
  })
  it('no consume saldo reservado', async () => {
    const { fees } = setup(10, 8)
    await expect(
      fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 }),
    ).rejects.toBeInstanceOf(AuctionPublicationFeeInsufficientBalanceError)
  })
  it('replay y conflictos de charge son deterministas', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
    await expect(
      fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 }),
    ).resolves.toMatchObject({ applied: false })
    expect(store.accounts.get('seller')?.balance).toBe(7)
    await expect(
      fees.charge({ operationId: 'charge', sellerId: 'other', amount: 3 }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await expect(
      fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 4 }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })
  it('refund es idempotente, detecta operation conflict y not found', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
    await fees.refund({ operationId: 'refund', chargeId: 'charge' })
    await expect(fees.refund({ operationId: 'refund', chargeId: 'charge' })).resolves.toMatchObject(
      { applied: false },
    )
    expect(store.accounts.get('seller')?.balance).toBe(10)
    await expect(fees.refund({ operationId: 'other', chargeId: 'missing' })).rejects.toBeInstanceOf(
      AuctionPublicationFeeNotFoundError,
    )
  })
  it('persiste cada operationId de refund y preserva conflicto global tras refund terminal', async () => {
    const { store, fees } = setup(20)
    await fees.charge({ operationId: 'charge-A', sellerId: 'seller', amount: 3 })
    await fees.charge({ operationId: 'charge-B', sellerId: 'seller', amount: 4 })
    await expect(
      fees.refund({ operationId: 'op-r1', chargeId: 'charge-A' }),
    ).resolves.toMatchObject({ applied: true })
    expect(store.accounts.get('seller')?.balance).toBe(16)
    await expect(
      fees.refund({ operationId: 'op-r1', chargeId: 'charge-A' }),
    ).resolves.toMatchObject({ applied: false })
    await expect(
      fees.refund({ operationId: 'op-r1', chargeId: 'charge-B' }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await expect(
      fees.refund({ operationId: 'op-r2', chargeId: 'charge-A' }),
    ).resolves.toMatchObject({ status: 'REFUNDED', applied: false })
    expect(store.publicationFeeRefunds.get('op-r2')).toBe('charge-A')
    expect(store.accounts.get('seller')?.balance).toBe(16)
    await expect(
      fees.refund({ operationId: 'op-r2', chargeId: 'charge-B' }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })
  it('rechaza amount invalido', () => {
    const { fees } = setup()
    expect(() => fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 0 })).toThrow(
      InvalidAuctionPublicationFeeAmountError,
    )
  })
})
