import { describe, it, expect } from 'vitest'
import { hashToken, extractPrivateToken } from '../../worker/lib/auth'

describe('hashToken', () => {
  it('is stable and produces base64', async () => {
    const a = await hashToken('secret')
    expect(a).toBe(await hashToken('secret'))
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('differs for different inputs', async () => {
    expect(await hashToken('a')).not.toBe(await hashToken('b'))
  })
})

describe('extractPrivateToken', () => {
  it('reads the x-private-token header', async () => {
    const req = new Request('http://x', { headers: { 'x-private-token': 'tok' } })
    expect(await extractPrivateToken(req)).toBe('tok')
  })

  it('returns null when absent', async () => {
    expect(await extractPrivateToken(new Request('http://x'))).toBeNull()
  })
})
