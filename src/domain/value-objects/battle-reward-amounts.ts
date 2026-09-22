import { DomainError } from '../errors/DomainError'

/**
 * Catalogo cerrado de montos validos para el contrato interno
 * Combat -> Wallet (`hu-22-reward-contract-v1.md`, S3).
 *
 * Wallet no confia en que Combat calcule bien el derecho de HU-21
 * (`BattleCreditsPolicy`): lo vuelve a verificar contra este catalogo antes
 * de acreditar nada. 2/4/1 son los unicos valores que esa politica puede
 * producir para un participante HUMANO.
 */
const VALID_CREDITS_AMOUNTS: ReadonlySet<number> = new Set([1, 2, 4])

/** 0 para quien no gano (o empate total); igual a `creditsAmount` para quien gano. */
const VALID_VICTORY_CREDITS_AMOUNTS: ReadonlySet<number> = new Set([0, 2, 4])

export const assertValidBattleRewardAmounts = (
  creditsAmount: number,
  victoryCreditsAmount: number,
): void => {
  if (!Number.isInteger(creditsAmount) || !VALID_CREDITS_AMOUNTS.has(creditsAmount)) {
    throw new DomainError(
      `creditsAmount fuera del catalogo cerrado {1,2,4}: ${String(creditsAmount)}`,
    )
  }

  if (
    !Number.isInteger(victoryCreditsAmount) ||
    !VALID_VICTORY_CREDITS_AMOUNTS.has(victoryCreditsAmount)
  ) {
    throw new DomainError(
      `victoryCreditsAmount fuera del catalogo cerrado {0,2,4}: ${String(victoryCreditsAmount)}`,
    )
  }

  if (victoryCreditsAmount !== 0 && victoryCreditsAmount !== creditsAmount) {
    throw new DomainError(
      'victoryCreditsAmount debe ser 0 (no ganador) o igual a creditsAmount (ganador).',
    )
  }
}
