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

import { Hono } from 'hono'
import { Env, User, Room } from '../lib/types'
import type { DurableRoom } from '../durable/DurableRoom'
import { newPublicId, newToken } from '../lib/ids'
import { extractPrivateToken, hmacIp } from '../lib/auth'
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator'
import { parseSettings, resolveSettings } from '../lib/settings'

function randomName(): string {
  return uniqueNamesGenerator({ dictionaries: [adjectives, animals], style: 'capital', separator: ' ' })
}

const users = new Hono<{ Bindings: Env }>()

async function getAuthedUser(c: any): Promise<User | null> {
  const privateToken = await extractPrivateToken(c.req.raw)
  if (!privateToken) return null
  const uid = c.req.param('uid') as string
  const roomId = c.req.param('roomId') as string
  if (!uid || !roomId) return null
  return c.env.DB.prepare(
    'SELECT * FROM users WHERE public_id = ? AND private_token = ? AND room_id = ?'
  ).bind(uid, privateToken, roomId).first() as Promise<User | null>
}

// Known bot/crawler User-Agent substrings that must never create a user.
// These headless agents render pages fully (including JS) but are not real
// participants. The list intentionally stays short — only agents observed to
// trigger POST /users in production should be added here.
const BOT_UA_PATTERNS = [
  'googlebot', 'google-read-aloud', 'bingbot', 'slurp', 'duckduckbot',
  'baiduspider', 'yandexbot', 'facebookexternalhit', 'twitterbot',
  'linkedinbot', 'whatsapp', 'telegrambot', 'applebot', 'headlesschrome',
  'puppeteer', 'playwright', 'selenium',
]

function isBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return BOT_UA_PATTERNS.some(p => ua.includes(p))
}

// POST /api/rooms/:roomId/users — join room
users.post('/', async (c) => {
  // Reject known bots and headless crawlers. These agents can render JS
  // fully and would otherwise create ghost users.
  const ua = c.req.header('user-agent') ?? ''
  if (isBot(ua)) {
    return c.json({ error: 'Automated agents cannot join a room' }, 403)
  }

  const roomId = c.req.param('roomId') as string
  const room = await c.env.DB.prepare(
    'SELECT id, settings, ip_salt FROM rooms WHERE id = ? AND expires_at > ?'
  ).bind(roomId, Math.floor(Date.now() / 1000)).first<Pick<Room, 'id' | 'settings' | 'ip_salt'>>()
  if (!room) return c.json({ error: 'Room not found or expired' }, 404)

  const settings = parseSettings(room.settings)
  const resolved = resolveSettings(settings, c.env)

  if (!settings.isOpen) return c.json({ error: 'This room is closed to new participants' }, 403)

  const maxParticipants = resolved.maxParticipants
  const rawIp = c.req.header('cf-connecting-ip') ?? ''
  // ip_hash is retained only for the admin "network_tag" (spotting bot/duplicate
  // accounts); it is no longer used to deduplicate joins — that wrongly merged
  // distinct people sharing an IP (event Wi-Fi, NAT, CGNAT).
  const ipHash = rawIp && room.ip_salt
    ? await hmacIp(rawIp, room.ip_salt)
    : null

  // The client mints its own high-entropy private token (persisted in its
  // localStorage) and sends it here. The token doubles as the join idempotency
  // key: it exists *before* the first request, so two near-simultaneous joins
  // from the same device (e.g. a link prefetch plus the real navigation) carry
  // the same token and collapse to a single account — without ever grouping
  // distinct people who merely share an IP. Reject anything too short/malformed
  // to keep the bearer token unguessable.
  const body = await c.req.json<{ privateToken?: string }>().catch(() => ({} as { privateToken?: string }))
  const privateToken = body.privateToken
  if (!privateToken || !/^[A-Za-z0-9]{32,128}$/.test(privateToken)) {
    return c.json({ error: 'A valid privateToken is required' }, 400)
  }

  // Idempotent fast path: this device already joined — return the same account
  // and skip the capacity check so a returning participant is never bounced.
  const existing = await c.env.DB.prepare(
    'SELECT public_id, display_name FROM users WHERE private_token = ? AND room_id = ?'
  ).bind(privateToken, roomId).first<{ public_id: string; display_name: string }>()
  if (existing) {
    return c.json({ publicId: existing.public_id, privateToken, displayName: existing.display_name }, 201)
  }

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM users WHERE room_id = ?'
  ).bind(roomId).first<{ n: number }>()

  if ((count?.n ?? 0) >= maxParticipants) {
    return c.json({ error: 'This room has reached its maximum number of participants' }, 403)
  }

  const publicId = newPublicId()
  const displayName = randomName()
  const now = Math.floor(Date.now() / 1000)

  // ON CONFLICT(private_token): if two first-time joins from the same device race
  // to this point, only one row is written; the loser falls through to re-read it
  // below, so both responses return the same identity.
  await c.env.DB.prepare(
    'INSERT INTO users (public_id, private_token, room_id, display_name, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(private_token) DO NOTHING'
  ).bind(publicId, privateToken, roomId, displayName, ipHash, now).run()

  // Re-read by token to get the canonical row (this insert's, or the race winner's).
  const created = await c.env.DB.prepare(
    'SELECT public_id, display_name FROM users WHERE private_token = ? AND room_id = ?'
  ).bind(privateToken, roomId).first<{ public_id: string; display_name: string }>()
  if (!created) return c.json({ error: 'Could not join room' }, 500)

  const doId = c.env.DURABLE_ROOM.idFromName(roomId)
  const stub = c.env.DURABLE_ROOM.get(doId) as unknown as DurableObjectStub<DurableRoom>
  await stub.broadcastBoardUpdate()

  console.info('user.joined', { room: roomId, user: created.public_id, displayName: created.display_name })
  return c.json({ publicId: created.public_id, privateToken, displayName: created.display_name }, 201)
})

// POST /api/rooms/:roomId/users/:uid/profile — update name/emoji
users.post('/:uid/profile', async (c) => {
  const user = await getAuthedUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ displayName?: string; emoji?: string }>()
  const name = body.displayName?.trim().slice(0, 40)
  const emoji = body.emoji?.trim().slice(0, 8)

  if (!name && !emoji) return c.json({ error: 'Nothing to update' }, 400)

  if (name && emoji) {
    await c.env.DB.prepare(
      'UPDATE users SET display_name = ?, emoji = ? WHERE public_id = ?'
    ).bind(name, emoji, user.public_id).run()
  } else if (name) {
    await c.env.DB.prepare(
      'UPDATE users SET display_name = ? WHERE public_id = ?'
    ).bind(name, user.public_id).run()
  } else {
    await c.env.DB.prepare(
      'UPDATE users SET emoji = ? WHERE public_id = ?'
    ).bind(emoji, user.public_id).run()
  }

  return c.json({ ok: true })
})

// POST /api/rooms/:roomId/users/:uid/qr-token — issue/refresh single-use scan token
users.post('/:uid/qr-token', async (c) => {
  const user = await getAuthedUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const token = newToken()
  await c.env.DB.prepare(
    'UPDATE users SET qr_token = ? WHERE public_id = ?'
  ).bind(token, user.public_id).run()

  return c.json({ token })
})

// GET /api/rooms/:roomId/users/:uid/score
users.get('/:uid/score', async (c) => {
  const user = await getAuthedUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const uid = user.public_id
  const roomId = user.room_id

  const encounters = await c.env.DB.prepare(`
    SELECT e.id, e.started_at, e.closed_at, e.counted, e.notified_at,
           CASE WHEN e.user_a_id = ? THEN e.user_b_id ELSE e.user_a_id END as partner_id,
           u.display_name as partner_name, u.emoji as partner_emoji
    FROM encounters e
    JOIN users u ON u.public_id = CASE WHEN e.user_a_id = ? THEN e.user_b_id ELSE e.user_a_id END
    WHERE e.room_id = ? AND (e.user_a_id = ? OR e.user_b_id = ?)
    ORDER BY e.started_at DESC
  `).bind(uid, uid, roomId, uid, uid).all()

  const counted = encounters.results.filter((e: any) => e.counted === 1)
  const pending = encounters.results.filter((e: any) => e.counted === 0)

  // Treasure hunt points contribute to the same unified score.
  const treasure = await c.env.DB.prepare(
    'SELECT COUNT(*) as found, COALESCE(SUM(points), 0) as points FROM treasure_scans WHERE user_id = ? AND room_id = ?'
  ).bind(uid, roomId).first<{ found: number; points: number }>()
  const treasurePoints = treasure?.points ?? 0
  const treasuresFound = treasure?.found ?? 0

  return c.json({
    publicId: uid,
    displayName: user.display_name,
    emoji: user.emoji,
    score: counted.length + treasurePoints,
    meetings: counted.length,
    treasurePoints,
    treasuresFound,
    encounters: encounters.results,
    pendingCount: pending.length,
  })
})

// GET /api/rooms/:roomId/users/:uid/ws
// All connections go through DurableRoom
users.get('/:uid/ws', async (c) => {
  const roomId = c.req.param('roomId') as string
  const uid = c.req.param('uid') as string
  // Browsers cannot set custom headers on WebSocket connections, so the private
  // token is carried in the Sec-WebSocket-Protocol header as the two subprotocol
  // values `qrmeet.token, <token>`. This keeps it out of the URL (and therefore
  // out of access/observability logs). Non-browser clients may use x-private-token.
  const subprotocols = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim())
  const protoToken = subprotocols[0] === 'qrmeet.token' ? subprotocols[1] : undefined
  const privateToken = c.req.header('x-private-token') ?? protoToken

  if (!privateToken) return c.json({ error: 'Unauthorized' }, 401)

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE public_id = ? AND private_token = ? AND room_id = ?'
  ).bind(uid, privateToken, roomId).first()
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Proxy to DurableRoom
  const doId = c.env.DURABLE_ROOM.idFromName(roomId)
  const stub = c.env.DURABLE_ROOM.get(doId)
  const wsUrl = new URL(c.req.url)
  wsUrl.pathname = '/ws'
  wsUrl.searchParams.delete('t') // never forward a token in the URL
  wsUrl.searchParams.set('userId', uid)

  return stub.fetch(new Request(wsUrl.toString(), c.req.raw))
})

export default users

