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
 * Stateless signed tokens for the passkey flows.
 *
 * The server keeps no session state (a deliberate design decision — see
 * architecture.md), so WebAuthn challenges cannot be "stored and looked up".
 * Instead a challenge IS its own proof: `b64url(JSON payload).b64url(HMAC)`.
 * simplewebauthn passes a string challenge through to the client verbatim, so
 * the signed payload round-trips inside clientDataJSON and comes back to the
 * verify endpoint, where only the HMAC (keyed by WEBAUTHN_SECRET), the expiry
 * and the purpose need checking.
 *
 * The same mechanism signs the one-time `linkToken` returned by auth-verify,
 * which lets POST /users link a brand-new profile to an already-authenticated
 * credential without a second WebAuthn ceremony.
 */

import { isoBase64URL } from '@simplewebauthn/server/helpers'

export type TokenPurpose = 'reg' | 'auth' | 'link'

export interface TokenPayload {
  p: TokenPurpose
  exp: number      // unix seconds
  n: string        // nonce — makes every challenge unique
  pid?: string     // reg: minted person_id (WebAuthn userHandle)
  uid?: string     // reg: public_id of the authenticated account
  cid?: string     // link: credential_id the new profile must be linked to
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function b64urlEncodeString(s: string): string {
  return isoBase64URL.fromUTF8String(s)
}

/** Sign a payload into a `payload.signature` token (both parts base64url). */
export async function signPayload(
  secret: string,
  payload: Omit<TokenPayload, 'n' | 'exp'> & { exp?: number },
  ttlSeconds: number,
): Promise<string> {
  const full: TokenPayload = {
    n: isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16))),
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
    ...payload,
  } as TokenPayload
  const body = b64urlEncodeString(JSON.stringify(full))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `${body}.${isoBase64URL.fromBuffer(new Uint8Array(sig))}`
}

/**
 * Verify a token's signature (constant-time via crypto.subtle.verify), expiry
 * and purpose. Returns the payload, or null for anything invalid.
 */
export async function verifyPayload(
  secret: string,
  token: string,
  purpose: TokenPurpose,
): Promise<TokenPayload | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!isoBase64URL.isBase64URL(sig)) return null
  const key = await hmacKey(secret)
  let ok = false
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      key,
      isoBase64URL.toBuffer(sig),
      new TextEncoder().encode(body),
    )
  } catch {
    return null
  }
  if (!ok) return null
  let payload: TokenPayload
  try {
    payload = JSON.parse(isoBase64URL.toUTF8String(body))
  } catch {
    return null
  }
  if (payload.p !== purpose) return null
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null
  return payload
}

/**
 * `expectedChallenge` callback for simplewebauthn's verify functions. The
 * challenge arrives base64url-encoded (as it appears in clientDataJSON);
 * decode it back to our `payload.sig` string and verify.
 */
export function challengeVerifier(secret: string, purpose: TokenPurpose) {
  return async (challenge: string): Promise<boolean> => {
    try {
      return !!(await verifyPayload(secret, isoBase64URL.toUTF8String(challenge), purpose))
    } catch {
      return false
    }
  }
}

/**
 * RP ID and expected origin for the WebAuthn ceremonies.
 *
 * Priority:
 * 1. WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN env overrides — needed for `wrangler dev`
 *    with a `[[routes]] custom_domain` config, which rewrites the request URL,
 *    Host AND a localhost Origin to the production domain while the page
 *    really runs on localhost:8787. Without the override the browser rejects
 *    the ceremony ("RP ID invalid for this domain"). Set in the local/sample
 *    wrangler.toml; deliberately NOT set in production (wrangler.ci.toml).
 * 2. The Origin header (every passkey call is a fetch() POST, which always
 *    carries it). Trusting the client-sent Origin is safe: the browser is the
 *    security boundary — a credential is bound to the page's domain at
 *    registration (rpIdHash) and clientDataJSON carries the real page origin
 *    under the authenticator's signature, so a forged header cannot make
 *    someone else's credential verify.
 * 3. The request URL host (integration tests, exotic clients).
 */
export function rpFromRequest(
  req: Request,
  env?: { WEBAUTHN_RP_ID?: string; WEBAUTHN_ORIGIN?: string },
): { rpID: string; expectedOrigin: string } {
  if (env?.WEBAUTHN_RP_ID) {
    return {
      rpID: env.WEBAUTHN_RP_ID,
      expectedOrigin: env.WEBAUTHN_ORIGIN || `https://${env.WEBAUTHN_RP_ID}`,
    }
  }
  const origin = req.headers.get('origin')
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin)
      return { rpID: u.hostname, expectedOrigin: u.origin }
    } catch { /* fall through */ }
  }
  const u = new URL(req.url)
  return { rpID: u.hostname, expectedOrigin: u.origin }
}

/** TTLs (seconds) for each token purpose. */
export const TOKEN_TTL: Record<TokenPurpose, number> = {
  reg: 300,
  auth: 300,
  link: 600,
}
