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
import { newRoomId } from '../lib/ids'
import { hashToken } from '../lib/auth'

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
  const expiresAt = now + 86400 // 24h

  await c.env.DB.prepare(
    'INSERT INTO rooms (id, name, admin_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, body.name ?? 'QRMeet', adminTokenHash, now, expiresAt).run()

  return c.json({ id, name: body.name ?? 'QRMeet', expiresAt })
})

rooms.get('/:roomId', async (c) => {
  const room = await c.env.DB.prepare(
    'SELECT id, name, created_at, expires_at FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId')).first<{ id: string; name: string; created_at: number; expires_at: number }>()

  if (!room) return c.json({ error: 'Room not found' }, 404)
  return c.json(room)
})

export default rooms
