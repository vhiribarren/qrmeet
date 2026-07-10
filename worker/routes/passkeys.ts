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

/**
 * Passkey (WebAuthn) profile recovery.
 *
 * A passkey is the only cross-context credential store a website can reach on
 * a device (Safari vs installed PWA vs webview all have isolated localStorage),
 * so it is the anchor that reunites those contexts under one player.
 *
 * Two routers:
 * - `passkeyReg`  (mounted under /api/rooms/:roomId/users/:uid/passkey) —
 *   registration, authenticated by the player's private token.
 * - `passkeyAuth` (mounted under /api/passkey) — authentication/recovery,
 *   public and domain-level: a passkey identifies a *person*, the response
 *   lists their accounts across all non-expired rooms.
 *
 * Challenges and link tokens are stateless HMAC-signed values — see
 * worker/lib/webauthn.ts.
 */

import { Hono } from 'hono'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server'
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers'
import { Env, Passkey } from '../lib/types'
import { getAuthedUser } from './users'
import { newToken } from '../lib/ids'
import {
  signPayload,
  verifyPayload,
  challengeVerifier,
  rpFromRequest,
  TOKEN_TTL,
} from '../lib/webauthn'

const RP_NAME = 'QRMeet'

// ── Registration (authenticated) ──

export const passkeyReg = new Hono<{ Bindings: Env }>()

// POST /api/rooms/:roomId/users/:uid/passkey/register-options
passkeyReg.post('/register-options', async (c) => {
  const user = await getAuthedUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // The client may resend a previously minted person_id (opaque, never trusted
  // for auth): re-registering with the same userHandle makes the platform
  // keychain REPLACE its entry instead of accumulating one per registration.
  const body = await c.req.json<{ personId?: string }>().catch(() => ({} as { personId?: string }))
  const personId = body.personId && /^[A-Za-z0-9]{32}$/.test(body.personId)
    ? body.personId
    : newToken()

  const room = await c.env.DB.prepare('SELECT name FROM rooms WHERE id = ?')
    .bind(user.room_id).first<{ name: string }>()

  const { rpID } = rpFromRequest(c.req.raw, c.env)
  const challenge = await signPayload(
    c.env.WEBAUTHN_SECRET,
    { p: 'reg', pid: personId, uid: user.public_id },
    TOKEN_TTL.reg,
  )

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: room?.name ? `QRMeet — ${room.name}` : 'QRMeet',
    userDisplayName: user.display_name || 'QRMeet player',
    userID: new TextEncoder().encode(personId) as Uint8Array<ArrayBuffer>,
    challenge,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',       // discoverable: recovery must work with no prior state
      userVerification: 'preferred',
    },
  })

  return c.json(options)
})

// POST /api/rooms/:roomId/users/:uid/passkey/register-verify
passkeyReg.post('/register-verify', async (c) => {
  const user = await getAuthedUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<RegistrationResponseJSON>().catch(() => null)
  if (!body?.response?.clientDataJSON) return c.json({ error: 'Invalid registration payload' }, 400)

  const { rpID, expectedOrigin } = rpFromRequest(c.req.raw, c.env)
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challengeVerifier(c.env.WEBAUTHN_SECRET, 'reg'),
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    })
  } catch (e) {
    return c.json({ error: 'Passkey verification failed' }, 400)
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'Passkey verification failed' }, 400)
  }

  // Re-extract the signed challenge payload to recover the minted person_id
  // and assert the ceremony was issued for THIS account (no server state).
  const clientData = decodeClientDataJSON(body.response.clientDataJSON)
  const payload = await verifyPayload(
    c.env.WEBAUTHN_SECRET,
    isoBase64URL.toUTF8String(clientData.challenge),
    'reg',
  )
  if (!payload || payload.uid !== user.public_id || !payload.pid) {
    return c.json({ error: 'Challenge does not match this account' }, 400)
  }

  const { credential } = verification.registrationInfo
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO passkeys (credential_id, public_key, counter, transports, person_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(credential_id) DO UPDATE SET public_key = excluded.public_key, counter = excluded.counter, last_used_at = excluded.last_used_at`
    ).bind(
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      payload.pid,
      now,
      now,
    ),
    c.env.DB.prepare(
      'INSERT OR REPLACE INTO passkey_links (credential_id, room_id, user_public_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(credential.id, user.room_id, user.public_id, now),
  ])

  console.info('passkey.registered', { room: user.room_id, user: user.public_id })
  return c.json({ ok: true, credentialId: credential.id, personId: payload.pid })
})

// ── Authentication / recovery (public, domain-level) ──

export const passkeyAuth = new Hono<{ Bindings: Env }>()

// POST /api/passkey/auth-options
passkeyAuth.post('/auth-options', async (c) => {
  const { rpID } = rpFromRequest(c.req.raw, c.env)
  const challenge = await signPayload(c.env.WEBAUTHN_SECRET, { p: 'auth' }, TOKEN_TTL.auth)
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [],          // discoverable credentials only
    userVerification: 'preferred',
    challenge,
  })
  return c.json(options)
})

// POST /api/passkey/auth-verify
passkeyAuth.post('/auth-verify', async (c) => {
  const body = await c.req.json<AuthenticationResponseJSON>().catch(() => null)
  if (!body?.id || !body?.response?.clientDataJSON) {
    return c.json({ error: 'Invalid authentication payload' }, 400)
  }

  const row = await c.env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?')
    .bind(body.id).first<Passkey>()
  if (!row) return c.json({ error: 'Unknown passkey' }, 404)

  const { rpID, expectedOrigin } = rpFromRequest(c.req.raw, c.env)
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challengeVerifier(c.env.WEBAUTHN_SECRET, 'auth'),
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: row.credential_id,
        publicKey: isoBase64URL.toBuffer(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    })
  } catch (e) {
    return c.json({ error: 'Passkey verification failed' }, 400)
  }
  if (!verification.verified) return c.json({ error: 'Passkey verification failed' }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?'
  ).bind(verification.authenticationInfo.newCounter, now, row.credential_id).run()

  // Every profile this person holds in a still-alive room. Most recent first,
  // so a context-free recovery (landing page) can adopt accounts[0].
  const accounts = await c.env.DB.prepare(`
    SELECT u.room_id AS roomId, r.name AS roomName,
           u.public_id AS publicId, u.private_token AS privateToken,
           u.display_name AS displayName, u.emoji
    FROM passkey_links pl
    JOIN users u ON u.public_id = pl.user_public_id AND u.room_id = pl.room_id
    JOIN rooms r ON r.id = pl.room_id AND r.expires_at > ?
    WHERE pl.credential_id = ?
    ORDER BY u.created_at DESC
  `).bind(now, row.credential_id).all()

  // One-time short-TTL token letting POST /users link a NEW profile to this
  // just-authenticated credential (new room case) without a second ceremony.
  const linkToken = await signPayload(
    c.env.WEBAUTHN_SECRET,
    { p: 'link', cid: row.credential_id },
    TOKEN_TTL.link,
  )

  console.info('passkey.authenticated', { credential: row.credential_id.slice(0, 8), accounts: accounts.results.length })
  return c.json({ accounts: accounts.results, linkToken, credentialId: row.credential_id, personId: row.person_id })
})
