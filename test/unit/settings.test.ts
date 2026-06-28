import { describe, it, expect } from 'vitest'
import { parseSettings, resolveSettings } from '../../worker/lib/settings'

describe('parseSettings', () => {
  it('applies defaults on empty input', () => {
    expect(parseSettings('{}')).toEqual({
      isOpen: true,
      scanningEnabled: true,
      questionsEnabled: true,
      encounterDurationSeconds: null,
      maxParticipants: null,
      treasureHuntEnabled: true,
      treasureDefaultPoints: 2,
      boardTopSize: 10,
    })
  })

  it('tolerates null and invalid JSON', () => {
    expect(parseSettings(null).treasureHuntEnabled).toBe(true)
    expect(parseSettings(undefined).treasureDefaultPoints).toBe(2)
    expect(parseSettings('not json').isOpen).toBe(true)
  })

  it('preserves provided values', () => {
    const s = parseSettings(JSON.stringify({ treasureHuntEnabled: false, treasureDefaultPoints: 10, isOpen: false }))
    expect(s.treasureHuntEnabled).toBe(false)
    expect(s.treasureDefaultPoints).toBe(10)
    expect(s.isOpen).toBe(false)
  })
})

describe('resolveSettings', () => {
  const env = { ENCOUNTER_DURATION_SECONDS: '42', MAX_PARTICIPANTS: '99' } as any

  it('falls back to env for null numeric settings', () => {
    const r = resolveSettings(parseSettings('{}'), env)
    expect(r.encounterDurationSeconds).toBe(42)
    expect(r.maxParticipants).toBe(99)
    expect(r.treasureHuntEnabled).toBe(true)
    expect(r.treasureDefaultPoints).toBe(2) // passthrough from parseSettings default
  })

  it('keeps explicit values over env fallbacks', () => {
    const r = resolveSettings(parseSettings(JSON.stringify({ encounterDurationSeconds: 7, maxParticipants: 5, treasureDefaultPoints: 9 })), env)
    expect(r.encounterDurationSeconds).toBe(7)
    expect(r.maxParticipants).toBe(5)
    expect(r.treasureDefaultPoints).toBe(9)
  })
})
