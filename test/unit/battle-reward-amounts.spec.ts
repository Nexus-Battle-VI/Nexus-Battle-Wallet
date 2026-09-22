import { assertValidBattleRewardAmounts } from '../../src/domain/value-objects/battle-reward-amounts'
import { DomainError } from '../../src/domain/errors/DomainError'

describe('assertValidBattleRewardAmounts', () => {
  it.each([
    [1, 0],
    [2, 2],
    [4, 4],
  ])('acepta creditsAmount=%i victoryCreditsAmount=%i', (credits, victory) => {
    expect(() => {
      assertValidBattleRewardAmounts(credits, victory)
    }).not.toThrow()
  })

  it.each([0, 3, 5, -1, 1.5])('rechaza creditsAmount fuera del catalogo cerrado: %s', (credits) => {
    expect(() => {
      assertValidBattleRewardAmounts(credits, 0)
    }).toThrow(DomainError)
  })

  it.each([1, 3, 5])('rechaza victoryCreditsAmount fuera del catalogo cerrado: %s', (victory) => {
    expect(() => {
      assertValidBattleRewardAmounts(2, victory)
    }).toThrow(DomainError)
  })

  it('rechaza victoryCreditsAmount distinto de 0 y de creditsAmount', () => {
    expect(() => {
      assertValidBattleRewardAmounts(2, 4)
    }).toThrow(DomainError)
    expect(() => {
      assertValidBattleRewardAmounts(4, 2)
    }).toThrow(DomainError)
  })
})
