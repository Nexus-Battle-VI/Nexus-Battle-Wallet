import { weekIdentityOf } from '../../src/domain/value-objects/week-identity'

describe('weekIdentityOf (America/Bogota)', () => {
  it('un martes cae en el lunes de esa misma semana', () => {
    // 2026-09-22 es martes.
    expect(weekIdentityOf(new Date('2026-09-22T15:00:00.000Z'))).toBe('2026-09-21')
  })

  it('el propio lunes es su propia identidad', () => {
    expect(weekIdentityOf(new Date('2026-09-21T05:00:00.000Z'))).toBe('2026-09-21')
  })

  it('domingo 23:59:59 America/Bogota sigue perteneciendo a la semana que termina', () => {
    // Domingo 2026-09-27 23:59:59 America/Bogota = 2026-09-28T04:59:59Z (UTC-05).
    expect(weekIdentityOf(new Date('2026-09-28T04:59:59.000Z'))).toBe('2026-09-21')
  })

  it('lunes 00:00:00 America/Bogota ya pertenece a la semana nueva', () => {
    // Lunes 2026-09-28 00:00:00 America/Bogota = 2026-09-28T05:00:00Z.
    expect(weekIdentityOf(new Date('2026-09-28T05:00:00.000Z'))).toBe('2026-09-28')
  })

  it('la conversion usa la zona de Bogota, no la del proceso', () => {
    // 2026-09-21T02:00:00Z es 2026-09-20 21:00 en Bogota (UTC-05): todavia domingo,
    // asi que pertenece a la semana anterior (lunes 2026-09-14).
    expect(weekIdentityOf(new Date('2026-09-21T02:00:00.000Z'))).toBe('2026-09-14')
  })

  it('sabado cae en el lunes de su semana', () => {
    // 2026-09-26 es sabado.
    expect(weekIdentityOf(new Date('2026-09-26T12:00:00.000Z'))).toBe('2026-09-21')
  })
})
