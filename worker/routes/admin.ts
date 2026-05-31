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
import { hashToken } from '../lib/auth'

const admin = new Hono<{ Bindings: Env }>()

async function verifyAdmin(c: any): Promise<boolean> {
  const adminToken = c.req.header('x-admin-token')
  if (!adminToken) return false
  const room = await c.env.DB.prepare(
    'SELECT admin_token_hash FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId') as string).first() as { admin_token_hash: string } | null
  if (!room) return false
  return room.admin_token_hash === await hashToken(adminToken)
}

// ── Admin endpoints (auth required) ──

// GET /api/admin/rooms/:roomId/scores
admin.get('/rooms/:roomId/scores', async (c) => {
  if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)

  const room = await c.env.DB.prepare(
    'SELECT expires_at FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId')).first<{ expires_at: number }>()

  const scores = await c.env.DB.prepare(`
    SELECT
      u.public_id,
      u.display_name,
      u.emoji,
      u.created_at,
      COUNT(CASE WHEN e.counted = 1 THEN 1 END) as score
    FROM users u
    LEFT JOIN encounters e
      ON e.room_id = u.room_id
      AND (e.user_a_id = u.public_id OR e.user_b_id = u.public_id)
    WHERE u.room_id = ?
    GROUP BY u.public_id
    ORDER BY score DESC, u.created_at ASC
  `).bind(c.req.param('roomId')).all()

  return c.json({ scores: scores.results, expiresAt: room?.expires_at ?? null })
})

// GET /api/admin/rooms/:roomId/graph
admin.get('/rooms/:roomId/graph', async (c) => {
  if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
  const roomId = c.req.param('roomId')

  const usersRes = await c.env.DB.prepare(
    'SELECT public_id, display_name, emoji FROM users WHERE room_id = ?'
  ).bind(roomId).all()

  const encountersRes = await c.env.DB.prepare(
    'SELECT user_a_id, user_b_id, started_at, counted FROM encounters WHERE room_id = ? AND counted = 1'
  ).bind(roomId).all()

  return c.json({
    nodes: usersRes.results,
    edges: encountersRes.results,
  })
})

// DELETE /api/admin/rooms/:roomId/users/:uid
admin.delete('/rooms/:roomId/users/:uid', async (c) => {
  if (!await verifyAdmin(c)) {
    console.warn('admin.unauthorized', { room: c.req.param('roomId'), endpoint: c.req.path })
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const uid    = c.req.param('uid')
  const roomId = c.req.param('roomId')
  await c.env.DB.prepare(
    'DELETE FROM encounters WHERE room_id = ? AND (user_a_id = ? OR user_b_id = ?)'
  ).bind(roomId, uid, uid).run()
  await c.env.DB.prepare(
    'DELETE FROM users WHERE public_id = ? AND room_id = ?'
  ).bind(uid, roomId).run()
  console.info('admin.user.deleted', { room: roomId, user: uid })
  return c.json({ ok: true })
})

export default admin
