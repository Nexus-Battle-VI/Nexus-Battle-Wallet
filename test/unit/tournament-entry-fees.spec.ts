import {
  TournamentEntryFeeInsufficientBalanceError,
  TournamentEntryFeeNotFoundError,
  InvalidTournamentEntryFeeAmountError,
} from '../../src/application/errors/TournamentEntryFeeError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import { TournamentEntryFees } from '../../src/application/use-cases/TournamentEntryFees'
import { InMemoryTournamentEntryFeeRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEntryFeeRepository'
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
    fees: new TournamentEntryFees(new InMemoryTournamentEntryFeeRepository(store), {
      now: () => now,
    }),
  }
}
describe('TournamentEntryFees', () => {
  it('120/100 deja 20 y un cobro devuelto permanece devuelto al repetirlo', async () => {
    const { store, fees } = setup(120)
    const input = {
      operationId: 'hu84',
      payerId: 'seller',
      amount: 100,
      tournamentId: 'T1',
      teamId: 'team1',
    }
    await fees.charge(input)
    expect(store.accounts.get('seller')?.balance).toBe(20)
    await fees.refund({ operationId: 'hu84-refund', chargeId: 'hu84' })
    expect((await fees.charge(input)).status).toBe('REFUNDED')
    expect(store.accounts.get('seller')?.balance).toBe(120)
  })
  it('99/100 persiste rechazo; recargar saldo no convierte el replay en otro cobro', async () => {
    const { store, fees } = setup(99)
    const input = {
      operationId: 'rejected',
      payerId: 'seller',
      amount: 100,
      tournamentId: 'T1',
      teamId: 'team1',
    }
    await expect(fees.charge(input)).rejects.toBeInstanceOf(
      TournamentEntryFeeInsufficientBalanceError,
    )
    store.accounts.get('seller')!.balance = 120
    await expect(fees.charge(input)).rejects.toBeInstanceOf(
      TournamentEntryFeeInsufficientBalanceError,
    )
    expect(store.accounts.get('seller')?.balance).toBe(120)
    await fees.charge({ ...input, operationId: 'new-attempt' })
    expect(store.accounts.get('seller')?.balance).toBe(20)
  })
  it('charge/refund restaura balance sin tocar reserved ni progreso', async () => {
    const { store, fees } = setup()
    await expect(
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 3,
      }),
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
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 3,
      }),
    ).rejects.toBeInstanceOf(TournamentEntryFeeInsufficientBalanceError)
  })
  it('replay y conflictos de charge son deterministas', async () => {
    const { store, fees } = setup()
    await fees.charge({
      operationId: 'charge',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 3,
    })
    await expect(
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 3,
      }),
    ).resolves.toMatchObject({ applied: false })
    expect(store.accounts.get('seller')?.balance).toBe(7)
    await expect(
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'other',
        amount: 3,
      }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    await expect(
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 4,
      }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })
  it('refund es idempotente, detecta operation conflict y not found', async () => {
    const { store, fees } = setup()
    await fees.charge({
      operationId: 'charge',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 3,
    })
    await fees.refund({ operationId: 'refund', chargeId: 'charge' })
    await expect(fees.refund({ operationId: 'refund', chargeId: 'charge' })).resolves.toMatchObject(
      { applied: false },
    )
    expect(store.accounts.get('seller')?.balance).toBe(10)
    await expect(fees.refund({ operationId: 'other', chargeId: 'missing' })).rejects.toBeInstanceOf(
      TournamentEntryFeeNotFoundError,
    )
  })
  it('persiste cada operationId de refund y preserva conflicto global tras refund terminal', async () => {
    const { store, fees } = setup(20)
    await fees.charge({
      operationId: 'charge-A',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 3,
    })
    await fees.charge({
      operationId: 'charge-B',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 4,
    })
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
    expect(store.entryFeeRefunds.get('op-r2')).toBe('charge-A')
    expect(store.accounts.get('seller')?.balance).toBe(16)
    await expect(
      fees.refund({ operationId: 'op-r2', chargeId: 'charge-B' }),
    ).rejects.toBeInstanceOf(OperationConflictError)
  })
  it('rechaza amount invalido', async () => {
    const { fees } = setup()
    await expect(
      fees.charge({
        operationId: 'charge',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 0,
      }),
    ).rejects.toBeInstanceOf(InvalidTournamentEntryFeeAmountError)
  })

  it('repite la devolución con su propio operationId y la misma tupla', async () => {
    const { fees } = setup(120.5)
    const charge = await fees.charge({
      operationId: 'echo-charge',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 100,
    })
    const first = await fees.refund({ operationId: 'echo-refund', chargeId: charge.chargeId })
    const replay = await fees.refund({ operationId: 'echo-refund', chargeId: charge.chargeId })
    expect(first).toEqual({
      ...charge,
      operationId: 'echo-refund',
      status: 'REFUNDED',
      applied: true,
    })
    expect(replay).toEqual({ ...first, applied: false })
  })

  it('rechaza reutilizar una operación de cobro como devolución y viceversa', async () => {
    const { fees, store } = setup(120)
    const input = {
      operationId: 'kind-charge',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 10,
    }
    await fees.charge(input)
    await expect(
      fees.refund({ operationId: 'kind-charge', chargeId: 'kind-charge' }),
    ).rejects.toBeInstanceOf(OperationConflictError)
    expect(store.accounts.get('seller')?.balance).toBe(110)
    await fees.refund({ operationId: 'kind-refund', chargeId: 'kind-charge' })
    await expect(fees.charge({ ...input, operationId: 'kind-refund' })).rejects.toBeInstanceOf(
      OperationConflictError,
    )
    expect(store.accounts.get('seller')?.balance).toBe(120)
  })

  it('registra exactamente un movimiento de cobro y devolución con medios créditos', async () => {
    const { fees, store } = setup(120.5, 20)
    const input = {
      operationId: 'half-charge',
      tournamentId: 'T1',
      teamId: 'team1',
      payerId: 'seller',
      amount: 100,
    }
    const results = await Promise.all([fees.charge(input), fees.charge(input)])
    expect(results.map((result) => result.applied).sort()).toEqual([false, true])
    expect(store.accounts.get('seller')).toMatchObject({ balance: 20.5, reserved: 20 })
    await Promise.all([
      fees.refund({ operationId: 'half-r1', chargeId: 'half-charge' }),
      fees.refund({ operationId: 'half-r2', chargeId: 'half-charge' }),
    ])
    expect(store.accounts.get('seller')).toMatchObject({ balance: 120.5, reserved: 20 })
    expect([...store.entryFeeLedger.values()]).toEqual([
      { chargeId: 'half-charge', kind: 'CHARGE', amount: 100, resultingBalance: 20.5 },
      { chargeId: 'half-charge', kind: 'REFUND', amount: 100, resultingBalance: 120.5 },
    ])
  })

  it.each(['operationId', 'tournamentId', 'teamId', 'payerId'] as const)(
    'valida %s antes de tocar el repositorio',
    async (field) => {
      const { fees, store } = setup(120)
      const input = {
        operationId: 'valid',
        tournamentId: 'T1',
        teamId: 'team1',
        payerId: 'seller',
        amount: 100,
      }
      for (const invalid of ['  ', 'x'.repeat(201)]) {
        await expect(fees.charge({ ...input, [field]: invalid })).rejects.toBeInstanceOf(
          InvalidTournamentEntryFeeAmountError,
        )
      }
      expect(store.accounts.get('seller')?.balance).toBe(120)
      expect(store.entryFees.size).toBe(0)
    },
  )

  it('rechaza identificadores vacíos o largos al compensar', async () => {
    const { fees } = setup()
    for (const invalid of ['', 'x'.repeat(201)]) {
      await expect(
        fees.refund({ operationId: invalid, chargeId: 'charge' }),
      ).rejects.toBeInstanceOf(InvalidTournamentEntryFeeAmountError)
      await expect(
        fees.refund({ operationId: 'refund', chargeId: invalid }),
      ).rejects.toBeInstanceOf(InvalidTournamentEntryFeeAmountError)
    }
  })
})
