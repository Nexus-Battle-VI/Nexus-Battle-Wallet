import {
  assertValidStakeAmount,
  assertValidStakeCreditAmount,
  InvalidStakeAmountError,
} from '../../src/domain/value-objects/stake-amount'

describe('StakeAmount', () => {
  it('acepta el minimo (1) y valores enteros mayores', () => {
    expect(() => {
      assertValidStakeAmount(1)
    }).not.toThrow()
    expect(() => {
      assertValidStakeAmount(250)
    }).not.toThrow()
  })

  it.each([[0], [-1], [-100]])('rechaza el monto no positivo %i (D5)', (amount) => {
    expect(() => {
      assertValidStakeAmount(amount)
    }).toThrow(InvalidStakeAmountError)
  })

  it.each([[1.5], [0.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rechaza el monto no entero %s',
    (amount) => {
      expect(() => {
        assertValidStakeAmount(amount)
      }).toThrow(InvalidStakeAmountError)
    },
  )

  it('no impone un techo propio: el maximo es el disponible, que decide el repositorio', () => {
    expect(() => {
      assertValidStakeAmount(10_000_000)
    }).not.toThrow()
  })

  it('una parte acreditada puede ser 0 (nadie del equipo perdedor aposto)', () => {
    expect(() => {
      assertValidStakeCreditAmount(0)
    }).not.toThrow()
    expect(() => {
      assertValidStakeCreditAmount(12)
    }).not.toThrow()
  })

  it.each([[-1], [0.5], [Number.NaN]])('rechaza una parte acreditada invalida %s', (amount) => {
    expect(() => {
      assertValidStakeCreditAmount(amount)
    }).toThrow(InvalidStakeAmountError)
  })
})
