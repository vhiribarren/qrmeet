import { describe, it, expect } from 'vitest'
import { newPublicId, newRoomId, newToken, newEncounterId, generateToken } from '../../worker/lib/ids'

describe('id generators', () => {
  it('public id: 12 lowercase alphanumerics', () => {
    expect(newPublicId()).toMatch(/^[a-z0-9]{12}$/)
  })

  it('room id: 6 lowercase alphanumerics', () => {
    expect(newRoomId()).toMatch(/^[a-z0-9]{6}$/)
  })

  it('encounter id: 12 lowercase alphanumerics', () => {
    expect(newEncounterId()).toMatch(/^[a-z0-9]{12}$/)
  })

  it('tokens: 32 mixed-case alphanumerics, and unique', () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(generateToken()).not.toBe(generateToken())
  })
})
