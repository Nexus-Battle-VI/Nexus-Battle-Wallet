import {
  AuctionPublicationFeeInsufficientBalanceError,
  AuctionPublicationFeeNotFoundError,
  AuctionPublicationFeeRefundExceedsChargeError,
  InvalidAuctionPublicationFeeAmountError,
  InvalidAuctionPublicationFeeRefundAmountError,
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
    expect(store.publicationFeeRefunds.get('op-r2')).toEqual({ chargeId: 'charge-A', amount: 3 })
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
  it('HU-90: reembolsa la mitad de una comision de 1 credito (0.5)', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 1 })
    expect(store.accounts.get('seller')?.balance).toBe(9)
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 0.5 }),
    ).resolves.toMatchObject({ status: 'REFUNDED', applied: true, amount: 0.5 })
    expect(store.accounts.get('seller')?.balance).toBe(9.5)
  })
  it('HU-90: reembolsa la mitad de una comision de 3 creditos (1.5)', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
    expect(store.accounts.get('seller')?.balance).toBe(7)
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 1.5 }),
    ).resolves.toMatchObject({ status: 'REFUNDED', applied: true, amount: 1.5 })
    expect(store.accounts.get('seller')?.balance).toBe(8.5)
  })
  it.each([[0], [-0.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rechaza un refund con amount no positivo o no finito (%s)',
    async (amount) => {
      const { fees } = setup()
      await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
      // La validacion es sincronica (igual que `charge`): lanza antes de
      // devolver una promesa, por eso no se usa `.rejects` aqui.
      expect(() => fees.refund({ operationId: 'refund', chargeId: 'charge', amount })).toThrow(
        InvalidAuctionPublicationFeeRefundAmountError,
      )
    },
  )
  it.each([[0.25], [1.25]])('rechaza un refund que no es multiplo de 0.5 (%s)', async (amount) => {
    const { fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
    expect(() => fees.refund({ operationId: 'refund', chargeId: 'charge', amount })).toThrow(
      InvalidAuctionPublicationFeeRefundAmountError,
    )
  })
  it('rechaza un refund mayor a lo cobrado', async () => {
    const { fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 1 })
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 1.5 }),
    ).rejects.toBeInstanceOf(AuctionPublicationFeeRefundExceedsChargeError)
  })
  it('un refund parcial es idempotente: mismo operationId+amount replay, distinto amount conflicto', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'charge', sellerId: 'seller', amount: 3 })
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 1.5 }),
    ).resolves.toMatchObject({ applied: true, amount: 1.5 })
    expect(store.accounts.get('seller')?.balance).toBe(8.5)
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 1.5 }),
    ).resolves.toMatchObject({ applied: false, amount: 1.5 })
    expect(store.accounts.get('seller')?.balance).toBe(8.5)
    await expect(
      fees.refund({ operationId: 'refund', chargeId: 'charge', amount: 1 }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })
  it('publicacion normal de 1 y 3 creditos sigue funcionando sin amount en el refund', async () => {
    const { store, fees } = setup()
    await fees.charge({ operationId: 'c24', sellerId: 'seller', amount: 1 })
    await fees.charge({ operationId: 'c48', sellerId: 'seller', amount: 3 })
    expect(store.accounts.get('seller')?.balance).toBe(6)
    await fees.refund({ operationId: 'r24', chargeId: 'c24' })
    await fees.refund({ operationId: 'r48', chargeId: 'c48' })
    expect(store.accounts.get('seller')?.balance).toBe(10)
  })
})
