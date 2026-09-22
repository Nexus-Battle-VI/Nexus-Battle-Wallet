import { applyVictoryCredits } from '../../src/domain/policies/ChestEligibilityPolicy'

describe('applyVictoryCredits (HU-22, Management #69)', () => {
  it('participacion (0) no mueve el progreso ni genera cofre', () => {
    const result = applyVictoryCredits({ victoryProgress: 5, weeklyChestCount: 0 }, 0)

    expect(result).toEqual({ victoryProgress: 5, weeklyChestCount: 0, chestEarned: false })
  })

  it('una victoria 1v1 (+2) por debajo del umbral solo acumula', () => {
    const result = applyVictoryCredits({ victoryProgress: 10, weeklyChestCount: 0 }, 2)

    expect(result).toEqual({ victoryProgress: 12, weeklyChestCount: 0, chestEarned: false })
  })

  it.each([
    [18, 2],
    [18, 4],
    [19, 2],
    [16, 4],
  ])('%i + %i cruza el umbral: cofre y progreso a 0, sin remanente', (progress, credits) => {
    const result = applyVictoryCredits({ victoryProgress: progress, weeklyChestCount: 0 }, credits)

    expect(result).toEqual({ victoryProgress: 0, weeklyChestCount: 1, chestEarned: true })
  })

  it('20 exactos entrega cofre', () => {
    const result = applyVictoryCredits({ victoryProgress: 16, weeklyChestCount: 0 }, 4)

    expect(result.chestEarned).toBe(true)
    expect(result.victoryProgress).toBe(0)
  })

  it('el primer cofre de la semana sube el contador a 1/2', () => {
    const result = applyVictoryCredits({ victoryProgress: 18, weeklyChestCount: 0 }, 2)

    expect(result.weeklyChestCount).toBe(1)
  })

  it('el segundo cofre de la semana sube el contador a 2/2', () => {
    const result = applyVictoryCredits({ victoryProgress: 18, weeklyChestCount: 1 }, 2)

    expect(result).toEqual({ victoryProgress: 0, weeklyChestCount: 2, chestEarned: true })
  })

  it('con 2/2 ya alcanzados, una nueva victoria NO genera un tercer cofre', () => {
    const result = applyVictoryCredits({ victoryProgress: 0, weeklyChestCount: 2 }, 4)

    expect(result).toEqual({ victoryProgress: 0, weeklyChestCount: 2, chestEarned: false })
  })

  it('con 2/2 ya alcanzados, el progreso queda congelado en 0 aunque hubiera progreso previo', () => {
    // No deberia ocurrir en la practica (ganar el 2do cofre ya deja el progreso en 0),
    // pero la politica no debe "inventar" progreso residual bajo el limite semanal.
    const result = applyVictoryCredits({ victoryProgress: 15, weeklyChestCount: 2 }, 2)

    expect(result).toEqual({ victoryProgress: 0, weeklyChestCount: 2, chestEarned: false })
  })
})
