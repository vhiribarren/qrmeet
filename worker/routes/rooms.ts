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
import { Env } from '../lib/types'
import { newRoomId, generateToken, newPublicId } from '../lib/ids'
import { hashToken } from '../lib/auth'
import { DEFAULT_QUESTIONS } from '../lib/questions'

const rooms = new Hono<{ Bindings: Env }>()

rooms.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; adminPassword: string }>()
  if (!body.adminPassword) {
    return c.json({ error: 'adminPassword required' }, 400)
  }

  const id = newRoomId()
  // adminPassword is a client-side hash of the original password; we hash it again for storage.
  const adminTokenHash = await hashToken(body.adminPassword)
  const now = Math.floor(Date.now() / 1000)
  // Room lifetime is configurable via ROOM_TTL_DAYS (default: 7 days).
  const ttlDays = parseInt(c.env.ROOM_TTL_DAYS || '7')
  const expiresAt = now + ttlDays * 86400

  const name = body.name ?? 'QRMeet'
  const ipSalt = generateToken()
  // Snapshot the server default treasure points into the room at creation. The
  // room then owns a plain editable value (no live server-default resolution),
  // so changing TREASURE_DEFAULT_POINTS later only affects rooms created after.
  const settings = JSON.stringify({
    treasureDefaultPoints: parseInt(c.env.TREASURE_DEFAULT_POINTS || '2'),
  })
  await c.env.DB.prepare(
    'INSERT INTO rooms (id, name, admin_token_hash, created_at, expires_at, ip_salt, settings) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, adminTokenHash, now, expiresAt, ipSalt, settings).run()

  // Seed default questions for this room
  const questionInserts = DEFAULT_QUESTIONS.map(text =>
    c.env.DB.prepare(
      'INSERT INTO questions (id, room_id, text, created_at) VALUES (?, ?, ?, ?)'
    ).bind(newPublicId(), id, text, now)
  )
  if (questionInserts.length > 0) {
    await c.env.DB.batch(questionInserts)
  }

  console.info('room.created', { room: id, name, expiresAt })
  return c.json({ id, name, expiresAt })
})

rooms.get('/:roomId', async (c) => {
  const room = await c.env.DB.prepare(
    'SELECT id, name, created_at, expires_at FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId')).first<{ id: string; name: string; created_at: number; expires_at: number }>()

  if (!room) return c.json({ error: 'Room not found' }, 404)
  return c.json(room)
})

export default rooms
