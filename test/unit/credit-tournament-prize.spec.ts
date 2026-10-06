import {
  InvalidTournamentPrizeError,
  TournamentPrizeSchemaError,
} from '../../src/application/errors/TournamentPrizeError'
import { OperationConflictError } from '../../src/application/errors/WalletPersistenceError'
import {
  CreditTournamentPrize,
  normalizeTournamentPrize,
} from '../../src/application/use-cases/CreditTournamentPrize'
import { toTournamentPrizeHttpException } from '../../src/adapters/inbound/http/wallet-error.mapper'
import { qaTournamentPrize } from '../support/tournament-prize'

describe('Crédito HU-86: validación independiente de HTTP', () => {
  const input = qaTournamentPrize('unit')
  it('envía el derecho exacto al puerto y usa la hora de Wallet únicamente para persistir', async () => {
    const now = new Date('2026-10-05T19:00:00Z')
    const receipt = { ...input, receiptId: 'qa-receipt', status: 'DELIVERED' as const }
    const credit = jest.fn().mockResolvedValue(receipt)
    const useCase = new CreditTournamentPrize({ credit }, { now: () => now })
    expect(await useCase.execute(input)).toEqual(receipt)
    expect(credit).toHaveBeenCalledWith(input, now)
    expect(normalizeTournamentPrize({ ...input, amount: '9007199254740991' }).amount).toBe(
      '9007199254740991',
    )
  })
  it.each([
    '0',
    '-1',
    '1.5',
    '01',
    ' 1',
    '1 ',
    '1e3',
    '+1',
    '9007199254740992',
    '99999999999999999999',
    '',
  ])('rechaza importe %s sin tocar el puerto', (amount) => {
    const credit = jest.fn()
    const useCase = new CreditTournamentPrize({ credit }, { now: () => new Date() })
    expect(() => useCase.execute({ ...input, amount })).toThrow(InvalidTournamentPrizeError)
    expect(credit).not.toHaveBeenCalled()
  })
  it.each([
    null,
    [],
    2,
    { ...input, amount: 501 },
    { ...input, kind: 'EPIC' },
    { ...input, productId: 'qa-epic' },
    { ...input, playerId: '' },
    { ...input, heroId: ' qa-hero' },
    { ...input, finalRoomId: 'x'.repeat(161) },
    { ...input, playerId: 'p\0x' },
    { ...input, actor: 'qa-admin' },
    { ...input, productId: undefined },
  ])('rechaza schema inválido %#', (body) => {
    expect(() => normalizeTournamentPrize(body)).toThrow(TournamentPrizeSchemaError)
  })
  it('campos faltantes y referencias excesivas fallan; el orden JSON no cambia el propósito', () => {
    const missing = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'heroId'))
    expect(() => normalizeTournamentPrize(missing)).toThrow(TournamentPrizeSchemaError)
    expect(() => normalizeTournamentPrize({ ...input, operationId: 'x'.repeat(513) })).toThrow(
      TournamentPrizeSchemaError,
    )
    expect(normalizeTournamentPrize(Object.fromEntries(Object.entries(input).reverse()))).toEqual(
      input,
    )
  })
  it.each([
    [new TournamentPrizeSchemaError('schema'), 400, 'SCHEMA_INVALID'],
    [new InvalidTournamentPrizeError('amount'), 422, 'PRIZE_INVALID'],
    [new OperationConflictError('qa'), 409, 'OPERATION_ID_REUSED'],
    [new Error('private database failure'), 503, 'PRIZE_DEPENDENCY_UNAVAILABLE'],
  ])('mapea errores sin revelar detalles de persistencia %#', (error, status, code) => {
    const http = toTournamentPrizeHttpException(error)
    expect(http.getStatus()).toBe(status)
    expect(http.getResponse()).toMatchObject({ statusCode: status, code })
    if (status === 503) expect(JSON.stringify(http.getResponse())).not.toContain('private database')
  })
})
