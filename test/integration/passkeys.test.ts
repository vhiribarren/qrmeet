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

// Passkey routes. Real attestations/assertions cannot be generated inside
// workerd (simplewebauthn ships no test authenticator), so the WebAuthn
// happy paths are covered by the Playwright e2e suite (virtual authenticator);
// here we cover options shapes, error paths, the POST /users linkToken
// extension, and the deletion/prune lifecycle.

import { describe, it, expect } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { createRoom, joinUser, newPrivateToken, fetchWorker, env } from '../helpers'
import workerEntry from '../../worker/index'
import { signPayload, verifyPayload } from '../../worker/lib/webauthn'

const BASE = 'http://qrmeet.test'
const SECRET = (env as any).WEBAUTHN_SECRET as string

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetchWorker(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function seedPasskey(credentialId = `cred-${crypto.randomUUID()}`, lastUsedAt?: number) {
  const now = Math.floor(Date.now() / 1000)
  await (env as any).DB.prepare(
    'INSERT INTO passkeys (credential_id, public_key, counter, transports, person_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(credentialId, isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3])), 0, null, 'p'.repeat(32), now, lastUsedAt ?? now).run()
  return credentialId
}

async function linkRows(credentialId: string) {
  const { results } = await (env as any).DB.prepare(
    'SELECT * FROM passkey_links WHERE credential_id = ?'
  ).bind(credentialId).all()
  return results
}

describe('passkey registration endpoints', () => {
  it('register-options requires authentication', async () => {
    const { roomId } = await createRoom()
    const user = await joinUser(roomId)
    const res = await post(`/api/rooms/${roomId}/users/${user.publicId}/passkey/register-options`)
    expect(res.status).toBe(401)
  })

  it('register-options returns well-formed options with a verifiable challenge', async () => {
    const { roomId } = await createRoom({ name: 'Options Room' })
    const user = await joinUser(roomId)
    const res = await post(
      `/api/rooms/${roomId}/users/${user.publicId}/passkey/register-options`,
      {},
      { 'x-private-token': user.privateToken },
    )
    expect(res.status).toBe(200)
    const options = await res.json() as any
    // WEBAUTHN_RP_ID pins the RP ID in dev/test (see wrangler.toml [vars]).
    expect(options.rp.id).toBe('localhost')
    expect(options.rp.name).toBe('QRMeet')
    expect(options.user.name).toContain('Options Room')
    expect(options.authenticatorSelection.residentKey).toBe('required')
    // user.id is the base64url-encoded minted person_id (32-char token)
    expect(isoBase64URL.toUTF8String(options.user.id)).toMatch(/^[A-Za-z0-9]{32}$/)
    // the challenge is our stateless signed token
    const challenge = isoBase64URL.toUTF8String(options.challenge)
    const payload = await verifyPayload(SECRET, challenge, 'reg')
    expect(payload?.uid).toBe(user.publicId)
    expect(payload?.pid).toBeTruthy()
  })

  it('register-options reuses a well-formed client-supplied personId', async () => {
    const { roomId } = await createRoom()
    const user = await joinUser(roomId)
    const personId = 'A'.repeat(32)
    const res = await post(
      `/api/rooms/${roomId}/users/${user.publicId}/passkey/register-options`,
      { personId },
      { 'x-private-token': user.privateToken },
    )
    const options = await res.json() as any
    expect(isoBase64URL.toUTF8String(options.user.id)).toBe(personId)
  })

  it('register-verify rejects unauthenticated and malformed payloads', async () => {
    const { roomId } = await createRoom()
    const user = await joinUser(roomId)
    const path = `/api/rooms/${roomId}/users/${user.publicId}/passkey/register-verify`
    expect((await post(path, {})).status).toBe(401)
    expect((await post(path, {}, { 'x-private-token': user.privateToken })).status).toBe(400)
    expect((await post(path, { response: { clientDataJSON: 'garbage' } }, { 'x-private-token': user.privateToken })).status).toBe(400)
  })
})

describe('passkey authentication endpoints', () => {
  it('auth-options returns a verifiable stateless challenge', async () => {
    const res = await post('/api/passkey/auth-options')
    expect(res.status).toBe(200)
    const options = await res.json() as any
    expect(options.rpId).toBe('localhost')
    const challenge = isoBase64URL.toUTF8String(options.challenge)
    expect(await verifyPayload(SECRET, challenge, 'auth')).not.toBeNull()
  })

  it('auth-verify rejects malformed payloads and unknown credentials', async () => {
    expect((await post('/api/passkey/auth-verify', {})).status).toBe(400)
    const res = await post('/api/passkey/auth-verify', {
      id: 'unknown-credential',
      response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' },
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /users linkToken extension', () => {
  it('links a new profile to the credential on join', async () => {
    const { roomId } = await createRoom()
    const credentialId = await seedPasskey()
    const linkToken = await signPayload(SECRET, { p: 'link', cid: credentialId }, 60)
    const res = await post(`/api/rooms/${roomId}/users`, { privateToken: newPrivateToken(), linkToken })
    expect(res.status).toBe(201)
    const { publicId } = await res.json() as any
    const links = await linkRows(credentialId)
    expect(links).toHaveLength(1)
    expect(links[0].user_public_id).toBe(publicId)
    expect(links[0].room_id).toBe(roomId)
  })

  it('links on the idempotent re-join path too', async () => {
    const { roomId } = await createRoom()
    const token = newPrivateToken()
    const first = await joinUser(roomId, token)                    // no linkToken
    const credentialId = await seedPasskey()
    const linkToken = await signPayload(SECRET, { p: 'link', cid: credentialId }, 60)
    const res = await post(`/api/rooms/${roomId}/users`, { privateToken: token, linkToken })
    expect(res.status).toBe(201)
    expect((await res.json() as any).publicId).toBe(first.publicId)
    const links = await linkRows(credentialId)
    expect(links).toHaveLength(1)
    expect(links[0].user_public_id).toBe(first.publicId)
  })

  it('rejects an invalid or expired linkToken and creates no user', async () => {
    const { roomId } = await createRoom()
    const credentialId = await seedPasskey()
    const expired = await signPayload(SECRET, { p: 'link', cid: credentialId, exp: Math.floor(Date.now() / 1000) - 1 }, 60)
    const privateToken = newPrivateToken()

    for (const linkToken of [expired, 'garbage', await signPayload(SECRET, { p: 'auth' }, 60)]) {
      const res = await post(`/api/rooms/${roomId}/users`, { privateToken, linkToken })
      expect(res.status).toBe(400)
    }
    const user = await (env as any).DB.prepare('SELECT * FROM users WHERE private_token = ?').bind(privateToken).first()
    expect(user).toBeNull()
    expect(await linkRows(credentialId)).toHaveLength(0)
  })
})

describe('passkey lifecycle (deletion & prune)', () => {
  async function seedLinkedUser() {
    const { roomId, adminToken } = await createRoom()
    const user = await joinUser(roomId)
    const credentialId = await seedPasskey()
    const linkToken = await signPayload(SECRET, { p: 'link', cid: credentialId }, 60)
    await post(`/api/rooms/${roomId}/users`, { privateToken: user.privateToken, linkToken })
    expect(await linkRows(credentialId)).toHaveLength(1)
    return { roomId, adminToken, user, credentialId }
  }

  it('admin room deletion removes links but keeps credentials', async () => {
    const { roomId, adminToken, credentialId } = await seedLinkedUser()
    const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken },
    })
    expect(res.status).toBe(200)
    expect(await linkRows(credentialId)).toHaveLength(0)
    const cred = await (env as any).DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(credentialId).first()
    expect(cred).not.toBeNull()
  })

  it('admin user deletion removes that user’s links', async () => {
    const { roomId, adminToken, user, credentialId } = await seedLinkedUser()
    const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}/users/${user.publicId}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken },
    })
    expect(res.status).toBe(200)
    expect(await linkRows(credentialId)).toHaveLength(0)
  })

  it('cron prunes credentials unused for over a year, links included', async () => {
    const yearAgo = Math.floor(Date.now() / 1000) - 366 * 86400
    const stale = await seedPasskey(undefined, yearAgo)
    const fresh = await seedPasskey()
    const { roomId } = await createRoom()
    const user = await joinUser(roomId)
    await (env as any).DB.prepare(
      'INSERT INTO passkey_links (credential_id, room_id, user_public_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(stale, roomId, user.publicId, yearAgo).run()

    const ctx = createExecutionContext()
    await workerEntry.scheduled({ scheduledTime: Date.now(), cron: '0 * * * *' } as any, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(await (env as any).DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(stale).first()).toBeNull()
    expect(await linkRows(stale)).toHaveLength(0)
    expect(await (env as any).DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(fresh).first()).not.toBeNull()
  })
})
