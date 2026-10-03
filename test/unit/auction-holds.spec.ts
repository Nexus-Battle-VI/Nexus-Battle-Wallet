import { InvalidAuctionHoldDateError } from '../../src/application/errors/AuctionHoldError'
import { AuctionHolds } from '../../src/application/use-cases/AuctionHolds'
import { InMemoryAuctionHoldRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionHoldRepository'
import { InMemoryWalletStore } from '../../src/adapters/outbound/persistence/InMemoryWalletStore'

/**
 * HU-90 (PR1 Wallet): confirma que la migracion 007 (balance/reserved a
 * `numeric`) no relaja la regla de enteros de los holds de puja. La fraccion
 * de 0.5/1.5 solo existe para la penalizacion de publicacion; una puja sigue
 * siendo un entero.
 */
describe('AuctionHolds', () => {
  const now = new Date('2026-09-24T00:00:00.000Z')
  const closesAt = new Date('2026-09-25T00:00:00.000Z')
  const setup = () => {
    const store = new InMemoryWalletStore()
    store.accounts.set('bidder', {
      balance: 10,
      reserved: 0,
      victoryProgress: 0,
      weeklyChestCount: 0,
      weekIdentity: '2026-W39',
    })
    return new AuctionHolds(
      new InMemoryAuctionHoldRepository(store),
      { now: () => now },
      300_000,
      172_800_000,
    )
  }

  it.each([[1.5], [0.5], [Number.NaN]])(
    'rechaza un hold de puja fraccionario %s tras la migracion a numeric',
    async (amount) => {
      const holds = setup()
      await expect(
        holds.create({
          operationId: 'op',
          playerId: 'bidder',
          amount,
          auctionId: 'auction',
          bidId: 'bid',
          auctionClosesAt: closesAt,
        }),
      ).rejects.toBeInstanceOf(InvalidAuctionHoldDateError)
    },
  )

  it('sigue aceptando un hold de puja entero', async () => {
    const holds = setup()
    await expect(
      holds.create({
        operationId: 'op',
        playerId: 'bidder',
        amount: 5,
        auctionId: 'auction',
        bidId: 'bid',
        auctionClosesAt: closesAt,
      }),
    ).resolves.toMatchObject({ applied: true })
  })
})
