import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import workerEntry from '../worker/index'

const BASE = 'http://qrmeet.test'

// Drive the worker's own default export (full Hono app + middleware) with the real
// test bindings. Uses only non-deprecated APIs (the deprecated `SELF`/`env` from
// "cloudflare:test" are avoided).
export async function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await workerEntry.fetch(new Request(input, init), env as any, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

export { env }

// SHA-256 → base64, matching the client and scripts/simulate.ts.
export async function sha256Base64(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

async function json(res: Response): Promise<any> {
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return text }
}

export interface TestUser { publicId: string; privateToken: string }

export async function createRoom(opts: { name?: string; password?: string } = {}) {
  const password = opts.password ?? 'admin-pw'
  const adminToken = await sha256Base64(password)
  const res = await fetchWorker(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: opts.name ?? 'Test Room', adminPassword: adminToken }),
  })
  const data = await json(res)
  return { roomId: data.id as string, adminToken, expiresAt: data.expiresAt as number, res, data }
}

export async function joinUser(roomId: string): Promise<TestUser> {
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users`, { method: 'POST' })
  const data = await json(res)
  return { publicId: data.publicId, privateToken: data.privateToken }
}

export async function issueQrToken(roomId: string, user: TestUser): Promise<string> {
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users/${user.publicId}/qr-token`, {
    method: 'POST',
    headers: { 'x-private-token': user.privateToken },
  })
  return (await json(res)).token
}

// Perform a scan; issues a fresh QR token for the scannee first (as the client does).
export async function scan(roomId: string, scanner: TestUser, scannee: TestUser) {
  const qrToken = await issueQrToken(roomId, scannee)
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-private-token': scanner.privateToken },
    body: JSON.stringify({ scanneePublicId: scannee.publicId, qrToken }),
  })
  return { res, data: await json(res) }
}

export async function claimTreasure(roomId: string, user: TestUser, treasureId: string) {
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/treasures/${treasureId}/claim`, {
    method: 'POST',
    headers: { 'x-private-token': user.privateToken },
  })
  return { res, data: await json(res) }
}

// Drive a full confirmed encounter between two users (scan → timer elapsed → scan).
// The timer is marked elapsed via the exact UPDATE the DurableRoom alarm runs, so
// the confirm path is deterministic without real waiting.
export async function completeEncounter(roomId: string, a: TestUser, b: TestUser) {
  await scan(roomId, a, b)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    'UPDATE encounters SET notified_at = ? WHERE room_id = ? AND notified_at IS NULL'
  ).bind(now, roomId).run()
  return scan(roomId, a, b)
}

export async function getScore(roomId: string, user: TestUser) {
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users/${user.publicId}/score`, {
    headers: { 'x-private-token': user.privateToken },
  })
  return { res, data: await json(res) }
}

// ── Admin ──
export function admin(roomId: string, adminToken: string) {
  const h = (extra: Record<string, string> = {}) => ({ 'x-admin-token': adminToken, ...extra })
  return {
    get: async (p: string) => {
      const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}${p}`, { headers: h() })
      return { res, data: await json(res) }
    },
    post: async (p: string, body?: unknown) => {
      const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}${p}`, {
        method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(body ?? {}),
      })
      return { res, data: await json(res) }
    },
    put: async (p: string, body: unknown) => {
      const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}${p}`, {
        method: 'PUT', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
      })
      return { res, data: await json(res) }
    },
    del: async (p: string) => {
      const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}${p}`, { method: 'DELETE', headers: h() })
      return { res, data: await json(res) }
    },
  }
}

// Enable treasure hunt and create a treasure; returns its id.
export async function createTreasure(
  roomId: string,
  adminToken: string,
  body: { label?: string; points?: number | null } = {},
): Promise<string> {
  const a = admin(roomId, adminToken)
  await a.put('/settings', { treasureHuntEnabled: true })
  const { data } = await a.post('/treasures', body)
  return data.id
}

export { BASE }
