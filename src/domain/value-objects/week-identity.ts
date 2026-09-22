/**
 * Identidad de la semana funcional de HU-22: lunes 00:00 a domingo 23:59:59,
 * zona horaria `America/Bogota` (decision del PO, Management #69, 2026-09-22).
 *
 * La identidad es la fecha ISO (`YYYY-MM-DD`) del lunes de esa semana, leida
 * en calendario local de Bogota. No se usa numeracion de semana ISO (`YYYY-Www`)
 * para evitar sus casos de frontera de fin de ano; una fecha de lunes concreta
 * es igual de estable y mas simple de comparar.
 *
 * Bogota no observa horario de verano, asi que el desfase es fijo, pero se usa
 * `Intl.DateTimeFormat` (no aritmetica de desfase a mano) para que el calculo
 * sea correcto sin importar la zona horaria del proceso que ejecuta el codigo.
 */

const TIME_ZONE = 'America/Bogota'

const WEEKDAY_OFFSET_FROM_MONDAY: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

const DAY_MS = 24 * 60 * 60 * 1000

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * Fecha (`YYYY-MM-DD`) del lunes de la semana de Bogota que contiene `instant`.
 */
export const weekIdentityOf = (instant: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant)

  const get = (type: string): string => {
    const value = parts.find((part) => part.type === type)?.value

    if (value === undefined) {
      throw new Error(`No se pudo leer "${type}" de la fecha en ${TIME_ZONE}.`)
    }

    return value
  }

  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const weekday = get('weekday')
  const offset = WEEKDAY_OFFSET_FROM_MONDAY[weekday]

  if (offset === undefined) {
    throw new Error(`Dia de la semana no reconocido: "${weekday}".`)
  }

  // Ancla neutra a medianoche UTC del dia calendario leido en Bogota. Solo se
  // usa para restar dias enteros; no representa un instante real de Bogota.
  const localAnchor = Date.UTC(year, month - 1, day)
  const monday = new Date(localAnchor - offset * DAY_MS)

  return `${String(monday.getUTCFullYear())}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`
}
