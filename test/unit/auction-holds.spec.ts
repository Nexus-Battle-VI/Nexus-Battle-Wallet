import {
  AuctionHoldAlreadyCapturedError,
  AuctionHoldNotFoundError,
  InvalidAuctionHoldDateError,
} from '../../src/application/errors/AuctionHoldError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import {
  AUCTION_HOLD_RELEASE_REASONS,
  type AuctionHoldReleaseReason,
} from '../../src/application/ports/AuctionHoldRepositoryPort'
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

/**
 * HU-90 (CA-05): release de holds al cancelar una subasta. El release es
 * idempotente por estado -RELEASED/EXPIRED son no-op exitosos- y CAPTURED es
 * un error terminal distinguible, nunca un exito.
 */
describe('AuctionHolds.release', () => {
  const now = new Date('2026-09-24T00:00:00.000Z')
  const closesAt = new Date('2026-09-25T00:00:00.000Z')
  const setup = () => {
    const store = new InMemoryWalletStore()
    for (const playerId of ['bidder', 'seller']) {
      store.accounts.set(playerId, {
        balance: 100,
        reserved: 0,
        victoryProgress: 0,
        weeklyChestCount: 0,
        weekIdentity: '2026-W39',
      })
    }
    const clock = { current: now }
    const repository = new InMemoryAuctionHoldRepository(store)
    const holds = new AuctionHolds(repository, { now: () => clock.current }, 300_000, 172_800_000)
    const reserve = (holdId = 'hold-1', amount = 30) =>
      holds.create({
        operationId: holdId,
        playerId: 'bidder',
        amount,
        auctionId: 'auction-1',
        bidId: `bid-${holdId}`,
        auctionClosesAt: closesAt,
      })
    const bidder = () => store.accounts.get('bidder')
    return { store, repository, holds, reserve, bidder, clock }
  }

  it('expone AUCTION_CANCELLED junto a los motivos existentes', () => {
    expect(AUCTION_HOLD_RELEASE_REASONS).toEqual([
      'AUCTION_OUTBID',
      'AUCTION_SETTLEMENT_LOST',
      'AUCTION_CANCELLED',
    ])
  })

  it.each(AUCTION_HOLD_RELEASE_REASONS)(
    'ACTIVE + %s: libera la reserva con applied=true y deja reserved correcto',
    async (reason: AuctionHoldReleaseReason) => {
      const { holds, reserve, bidder } = setup()
      await reserve()
      expect(bidder()).toMatchObject({ balance: 100, reserved: 30 })

      await expect(
        holds.release({ operationId: 'release-1', holdId: 'hold-1', reason }),
      ).resolves.toEqual({
        operationId: 'release-1',
        holdId: 'hold-1',
        holdStatus: 'RELEASED',
        applied: true,
      })
      expect(bidder()).toMatchObject({ balance: 100, reserved: 0 })
    },
  )

  it('solo libera el hold pedido: otra reserva del mismo jugador sigue retenida', async () => {
    const { holds, reserve, bidder } = setup()
    await reserve('hold-1', 30)
    await reserve('hold-2', 20)

    await holds.release({ operationId: 'release-1', holdId: 'hold-1', reason: 'AUCTION_CANCELLED' })

    expect(bidder()).toMatchObject({ balance: 100, reserved: 20 })
  })

  it('el replay del mismo operationId con AUCTION_CANCELLED no libera dos veces', async () => {
    const { holds, reserve, bidder } = setup()
    await reserve('hold-1', 30)
    await reserve('hold-2', 20)
    const command = {
      operationId: 'release-1',
      holdId: 'hold-1',
      reason: 'AUCTION_CANCELLED',
    } as const
    const first = await holds.release(command)

    await expect(holds.release(command)).resolves.toEqual({ ...first, applied: false })
    expect(bidder()).toMatchObject({ balance: 100, reserved: 20 })
  })

  it('RELEASED por otra operacion: no-op exitoso, sin mover saldo', async () => {
    const { holds, reserve, bidder } = setup()
    await reserve('hold-1', 30)
    await reserve('hold-2', 20)
    await holds.release({ operationId: 'outbid-1', holdId: 'hold-1', reason: 'AUCTION_OUTBID' })

    const result = await holds.release({
      operationId: 'cancel-1',
      holdId: 'hold-1',
      reason: 'AUCTION_CANCELLED',
    })

    expect(result).toEqual({
      operationId: 'cancel-1',
      holdId: 'hold-1',
      holdStatus: 'RELEASED',
      applied: false,
    })
    // Un doble descuento dejaria reserved en -10.
    expect(bidder()).toMatchObject({ balance: 100, reserved: 20 })
  })

  it('EXPIRED: no-op exitoso que informa el estado real, sin mover saldo', async () => {
    const { holds, repository, reserve, bidder, clock } = setup()
    await reserve()
    clock.current = new Date(closesAt.getTime() + 300_000)
    await expect(repository.expire(clock.current)).resolves.toBe(1)
    expect(bidder()).toMatchObject({ balance: 100, reserved: 0 })

    const command = {
      operationId: 'cancel-1',
      holdId: 'hold-1',
      reason: 'AUCTION_CANCELLED',
    } as const
    const result = await holds.release(command)

    expect(result).toEqual({
      operationId: 'cancel-1',
      holdId: 'hold-1',
      holdStatus: 'EXPIRED',
      applied: false,
    })
    await expect(holds.release(command)).resolves.toEqual(result)
    expect(bidder()).toMatchObject({ balance: 100, reserved: 0 })
  })

  it.each(AUCTION_HOLD_RELEASE_REASONS)(
    'CAPTURED + %s: error terminal distinguible, nunca un exito, y reintentarlo no cambia',
    async (reason: AuctionHoldReleaseReason) => {
      const { holds, store, reserve, bidder } = setup()
      await reserve()
      await holds.capture({
        operationId: 'capture-1',
        holdId: 'hold-1',
        beneficiaryPlayerId: 'seller',
        auctionId: 'auction-1',
        winningBidId: 'bid-hold-1',
      })
      const command = { operationId: 'cancel-1', holdId: 'hold-1', reason }

      await expect(holds.release(command)).rejects.toBeInstanceOf(AuctionHoldAlreadyCapturedError)
      await expect(holds.release(command)).rejects.toBeInstanceOf(AuctionHoldAlreadyCapturedError)
      expect(bidder()).toMatchObject({ balance: 70, reserved: 0 })
      expect(store.accounts.get('seller')).toMatchObject({ balance: 130 })
      expect(store.auctionHolds.get('hold-1')?.status).toBe('CAPTURED')
    },
  )

  it('hold inexistente: AuctionHoldNotFoundError', async () => {
    const { holds } = setup()

    await expect(
      holds.release({ operationId: 'cancel-1', holdId: 'missing', reason: 'AUCTION_CANCELLED' }),
    ).rejects.toBeInstanceOf(AuctionHoldNotFoundError)
  })

  it('mismo operationId con otro reason es un conflicto, tambien tras un no-op', async () => {
    const { holds, reserve, bidder } = setup()
    await reserve()
    await holds.release({
      operationId: 'release-1',
      holdId: 'hold-1',
      reason: 'AUCTION_SETTLEMENT_LOST',
    })

    await expect(
      holds.release({ operationId: 'release-1', holdId: 'hold-1', reason: 'AUCTION_CANCELLED' }),
    ).rejects.toBeInstanceOf(OperationConflictError)

    // El no-op sobre un hold ya RELEASED tambien fija su intent.
    await holds.release({ operationId: 'noop-1', holdId: 'hold-1', reason: 'AUCTION_CANCELLED' })
    await expect(
      holds.release({ operationId: 'noop-1', holdId: 'hold-1', reason: 'AUCTION_OUTBID' }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    expect(bidder()).toMatchObject({ balance: 100, reserved: 0 })
  })
})
