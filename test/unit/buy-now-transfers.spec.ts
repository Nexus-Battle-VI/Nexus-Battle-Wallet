import {
  BuyNowTransferSameAccountError,
  InvalidBuyNowTransferAmountError,
} from '../../src/application/errors/BuyNowTransferError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { BuyNowTransfers } from '../../src/application/use-cases/BuyNowTransfers'
import { InMemoryBuyNowTransferRepository } from '../../src/adapters/outbound/persistence/InMemoryBuyNowTransferRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'

class FixedClock implements ClockPort {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant
  }
}

const AT = new Date('2026-09-23T15:00:00.000Z')

const setup = (buyerBalance: number, sellerBalance = 0) => {
  const store = new InMemoryWalletStore()
  store.accounts.set('comprador', {
    balance: buyerBalance,
    reserved: 0,
    victoryProgress: 0,
    weeklyChestCount: 0,
    weekIdentity: '2026-09-21',
  })
  store.accounts.set('vendedor', {
    balance: sellerBalance,
    reserved: 0,
    victoryProgress: 0,
    weeklyChestCount: 0,
    weekIdentity: '2026-09-21',
  })

  const repository = new InMemoryBuyNowTransferRepository(store)

  return { store, useCase: new BuyNowTransfers(repository, new FixedClock(AT)) }
}

describe('BuyNowTransfers (HU-64.8)', () => {
  it('transfiere del comprador al vendedor', async () => {
    const { useCase, store } = setup(5000, 1000)

    const result = await useCase.transfer({
      operationId: 'op-1',
      buyerId: 'comprador',
      sellerId: 'vendedor',
      amount: 2500,
    })

    expect(result).toMatchObject({ transferId: 'op-1', status: 'APPLIED', applied: true })
    expect(store.accounts.get('comprador')?.balance).toBe(2500)
    expect(store.accounts.get('vendedor')?.balance).toBe(3500)
  })

  it('rechaza un importe no entero o no positivo antes de tocar el repositorio', async () => {
    const { useCase, store } = setup(5000)

    await expect(
      useCase.transfer({ operationId: 'op-2', buyerId: 'comprador', sellerId: 'vendedor', amount: 0 }),
    ).rejects.toBeInstanceOf(InvalidBuyNowTransferAmountError)
    await expect(
      useCase.transfer({
        operationId: 'op-3',
        buyerId: 'comprador',
        sellerId: 'vendedor',
        amount: 10.5,
      }),
    ).rejects.toBeInstanceOf(InvalidBuyNowTransferAmountError)
    expect(store.accounts.get('comprador')?.balance).toBe(5000)
  })

  it('rechaza que el comprador y el vendedor sean la misma cuenta', async () => {
    const { useCase } = setup(5000)

    await expect(
      useCase.transfer({
        operationId: 'op-4',
        buyerId: 'comprador',
        sellerId: 'comprador',
        amount: 100,
      }),
    ).rejects.toBeInstanceOf(BuyNowTransferSameAccountError)
  })

  it('revierte una transferencia ya aplicada', async () => {
    const { useCase, store } = setup(5000, 1000)

    await useCase.transfer({
      operationId: 'op-5',
      buyerId: 'comprador',
      sellerId: 'vendedor',
      amount: 2000,
    })
    const reversed = await useCase.reverse({ operationId: 'reverse-5', transferId: 'op-5' })

    expect(reversed).toMatchObject({ status: 'REVERSED', applied: true })
    expect(store.accounts.get('comprador')?.balance).toBe(5000)
    expect(store.accounts.get('vendedor')?.balance).toBe(1000)
  })
})
