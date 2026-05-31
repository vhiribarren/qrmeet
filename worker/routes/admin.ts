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
import { Env, Room } from '../lib/types'
import { hashToken } from '../lib/auth'
import { purgeRoom } from '../lib/rooms'

const MAX_ENCOUNTER_DURATION_SECONDS = 3600

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
      SUBSTR(u.ip_hash, 1, 8) as network_tag,
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

// GET /api/admin/rooms/:roomId/settings
admin.get('/rooms/:roomId/settings', async (c) => {
  if (!await verifyAdmin(c)) {
    console.warn('admin.unauthorized', { room: c.req.param('roomId'), endpoint: c.req.path })
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const room = await c.env.DB.prepare(
    'SELECT name, is_open, encounter_duration_seconds, max_participants FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId')).first<Pick<Room, 'name' | 'is_open' | 'encounter_duration_seconds' | 'max_participants'>>()
  if (!room) return c.json({ error: 'Room not found' }, 404)

  const defaultDuration = parseInt(c.env.ENCOUNTER_DURATION_SECONDS || '300')
  const defaultMaxParticipants = parseInt(c.env.MAX_PARTICIPANTS || '100')
  return c.json({
    name: room.name,
    isOpen: room.is_open === 1,
    encounterDurationSeconds: room.encounter_duration_seconds ?? defaultDuration,
    encounterDurationIsDefault: room.encounter_duration_seconds === null,
    maxParticipants: room.max_participants ?? defaultMaxParticipants,
    maxParticipantsIsDefault: room.max_participants === null,
  })
})

// PUT /api/admin/rooms/:roomId/settings
admin.put('/rooms/:roomId/settings', async (c) => {
  if (!await verifyAdmin(c)) {
    console.warn('admin.unauthorized', { room: c.req.param('roomId'), endpoint: c.req.path })
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const roomId = c.req.param('roomId')
  const body = await c.req.json<{
    name?: string
    isOpen?: boolean
    encounterDurationSeconds?: number | null
    maxParticipants?: number | null
  }>()

  const updates: string[] = []
  const params: unknown[] = []

  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 40)
    if (!name) return c.json({ error: 'name cannot be empty' }, 400)
    updates.push('name = ?')
    params.push(name)
  }

  if (body.isOpen !== undefined) {
    updates.push('is_open = ?')
    params.push(body.isOpen ? 1 : 0)
  }

  if (body.encounterDurationSeconds !== undefined) {
    const value = body.encounterDurationSeconds
    if (value !== null) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_ENCOUNTER_DURATION_SECONDS) {
        return c.json({ error: `encounterDurationSeconds must be an integer between 1 and ${MAX_ENCOUNTER_DURATION_SECONDS}` }, 400)
      }
    }
    updates.push('encounter_duration_seconds = ?')
    params.push(value)
  }

  if (body.maxParticipants !== undefined) {
    const value = body.maxParticipants
    if (value !== null) {
      if (!Number.isInteger(value) || value < 1) {
        return c.json({ error: 'maxParticipants must be an integer >= 1' }, 400)
      }
    }
    updates.push('max_participants = ?')
    params.push(value)
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  params.push(roomId)
  await c.env.DB.prepare(
    `UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...params).run()

  console.info('admin.settings.updated', { room: roomId, updates: Object.keys(body) })
  return c.json({ ok: true })
})

// DELETE /api/admin/rooms/:roomId
admin.delete('/rooms/:roomId', async (c) => {
  if (!await verifyAdmin(c)) {
    console.warn('admin.unauthorized', { room: c.req.param('roomId'), endpoint: c.req.path })
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const roomId = c.req.param('roomId')
  await purgeRoom(c.env.DB, c.env.DURABLE_ROOM, roomId)
  console.info('admin.room.deleted', { room: roomId })
  return c.json({ ok: true })
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
