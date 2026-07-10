/**
 * MIT License
 *
 * Copyright (c) 2026 Vincent Hiribarren
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect } from 'vitest'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { signPayload, verifyPayload, challengeVerifier } from '../../worker/lib/webauthn'

const SECRET = 'unit-test-secret'

describe('signPayload / verifyPayload', () => {
  it('round-trips a payload', async () => {
    const token = await signPayload(SECRET, { p: 'auth' }, 60)
    const payload = await verifyPayload(SECRET, token, 'auth')
    expect(payload).not.toBeNull()
    expect(payload!.p).toBe('auth')
    expect(payload!.n).toBeTruthy()
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('carries extra fields (reg: pid/uid, link: cid)', async () => {
    const reg = await signPayload(SECRET, { p: 'reg', pid: 'person1', uid: 'user1' }, 60)
    const p = await verifyPayload(SECRET, reg, 'reg')
    expect(p!.pid).toBe('person1')
    expect(p!.uid).toBe('user1')

    const link = await signPayload(SECRET, { p: 'link', cid: 'cred1' }, 60)
    expect((await verifyPayload(SECRET, link, 'link'))!.cid).toBe('cred1')
  })

  it('generates unique tokens (nonce)', async () => {
    const a = await signPayload(SECRET, { p: 'auth' }, 60)
    const b = await signPayload(SECRET, { p: 'auth' }, 60)
    expect(a).not.toBe(b)
  })

  it('rejects an expired token', async () => {
    const token = await signPayload(SECRET, { p: 'auth', exp: Math.floor(Date.now() / 1000) - 1 }, 60)
    expect(await verifyPayload(SECRET, token, 'auth')).toBeNull()
  })

  it('rejects a purpose mismatch', async () => {
    const token = await signPayload(SECRET, { p: 'auth' }, 60)
    expect(await verifyPayload(SECRET, token, 'link')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const token = await signPayload(SECRET, { p: 'auth' }, 60)
    const [body, sig] = token.split('.')
    const forged = isoBase64URL.fromUTF8String(
      JSON.stringify({ ...JSON.parse(isoBase64URL.toUTF8String(body)), p: 'link' })
    )
    expect(await verifyPayload(SECRET, `${forged}.${sig}`, 'link')).toBeNull()
  })

  it('rejects a wrong secret', async () => {
    const token = await signPayload(SECRET, { p: 'auth' }, 60)
    expect(await verifyPayload('other-secret', token, 'auth')).toBeNull()
  })

  it('rejects malformed tokens', async () => {
    expect(await verifyPayload(SECRET, '', 'auth')).toBeNull()
    expect(await verifyPayload(SECRET, 'no-dot', 'auth')).toBeNull()
    expect(await verifyPayload(SECRET, 'a.!!invalid-b64!!', 'auth')).toBeNull()
    expect(await verifyPayload(SECRET, '.sig', 'auth')).toBeNull()
  })
})

describe('challengeVerifier', () => {
  it('accepts a base64url-encoded valid challenge', async () => {
    const token = await signPayload(SECRET, { p: 'reg', pid: 'p', uid: 'u' }, 60)
    const verify = challengeVerifier(SECRET, 'reg')
    // WebAuthn clients return the challenge base64url-encoded in clientDataJSON.
    expect(await verify(isoBase64URL.fromUTF8String(token))).toBe(true)
  })

  it('rejects a bad or mispurposed challenge', async () => {
    const token = await signPayload(SECRET, { p: 'auth' }, 60)
    expect(await challengeVerifier(SECRET, 'reg')(isoBase64URL.fromUTF8String(token))).toBe(false)
    expect(await challengeVerifier(SECRET, 'reg')('garbage')).toBe(false)
  })
})
