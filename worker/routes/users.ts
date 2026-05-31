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
import { Env, User } from '../lib/types'
import type { DurableRoom } from '../durable/DurableRoom'
import { newPublicId, generateToken, newToken } from '../lib/ids'
import { extractPrivateToken } from '../lib/auth'
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator'

function randomName(): string {
  return uniqueNamesGenerator({ dictionaries: [adjectives, animals], style: 'capital', separator: ' ' })
}

const users = new Hono<{ Bindings: Env }>()

// Rate limit: max 10 users per IP per room (simple KV counter)
async function checkRateLimit(kv: KVNamespace, ip: string, roomId: string, limit: number): Promise<boolean> {
  const key = `ratelimit:join:${roomId}:${ip}`
  const count = parseInt((await kv.get(key)) ?? '0')
  if (count >= limit) return false
  await kv.put(key, String(count + 1), { expirationTtl: 3600 })
  return true
}

function roomIdFromUrl(url: string): string {
  const m = url.match(/\/api\/rooms\/([^/]+)\/users/)
  return m?.[1] ?? ''
}

async function getAuthedUser(c: any): Promise<User | null> {
  const privateToken = await extractPrivateToken(c.req.raw)
  if (!privateToken) return null
  const uid = c.req.param('uid') as string
  const roomId = (c.req.param('roomId') as string | undefined) || roomIdFromUrl(c.req.url)
  if (!uid || !roomId) return null
  return c.env.DB.prepare(
    'SELECT * FROM users WHERE public_id = ? AND private_token = ? AND room_id = ?'
  ).bind(uid, privateToken, roomId).first() as Promise<User | null>
}

// POST /api/rooms/:roomId/users — join room
users.post('/', async (c) => {
  const roomId = (c.req.param('roomId') as string | undefined) || roomIdFromUrl(c.req.url)
  const room = await c.env.DB.prepare(
    'SELECT id FROM rooms WHERE id = ? AND expires_at > ?'
  ).bind(roomId, Math.floor(Date.now() / 1000)).first()
  if (!room) return c.json({ error: 'Room not found or expired' }, 404)

  const cfIp = c.req.header('cf-connecting-ip') ?? 'unknown'
  const isLoopback = cfIp === '127.0.0.1' || cfIp === '::1'
  const ip = isLoopback ? (c.req.header('x-forwarded-for') ?? cfIp) : cfIp
  const joinLimit = parseInt(c.env.MAX_JOINS_PER_IP || '500')
  if (!await checkRateLimit(c.env.QR_TOKENS, ip, roomId, joinLimit)) {
    return c.json({ error: 'Too many joins from this IP' }, 429)
  }

  const publicId = newPublicId()
  const privateToken = generateToken()
  const displayName = randomName()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(
    'INSERT INTO users (public_id, private_token, room_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(publicId, privateToken, roomId, displayName, now).run()

  const doId = c.env.DURABLE_ROOM.idFromName(roomId)
  const stub = c.env.DURABLE_ROOM.get(doId) as unknown as DurableObjectStub<DurableRoom>
  await stub.broadcastBoardUpdate()

  return c.json({ publicId, privateToken, displayName }, 201)
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
  const kvKey = `qrtoken:${user.room_id}:${user.public_id}`
  await c.env.QR_TOKENS.put(kvKey, token, { expirationTtl: 3600 })

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

  return c.json({
    publicId: uid,
    displayName: user.display_name,
    emoji: user.emoji,
    score: counted.length,
    encounters: encounters.results,
    pendingCount: pending.length,
  })
})

export default users
