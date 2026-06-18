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
import { newPublicId } from '../lib/ids'
import { parseSettings, resolveSettings, RoomSettings } from '../lib/settings'

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
    'SELECT name, settings FROM rooms WHERE id = ?'
  ).bind(c.req.param('roomId')).first<Pick<Room, 'name' | 'settings'>>()
  if (!room) return c.json({ error: 'Room not found' }, 404)

  const settings = parseSettings(room.settings)
  const resolved = resolveSettings(settings, c.env)
  const defaultDuration    = parseInt(c.env.ENCOUNTER_DURATION_SECONDS || '300')
  const defaultMaxParticipants = parseInt(c.env.MAX_PARTICIPANTS || '100')

  return c.json({
    name: room.name,
    isOpen:                      settings.isOpen,
    questionsEnabled:            settings.questionsEnabled,
    encounterDurationSeconds:    resolved.encounterDurationSeconds,
    encounterDurationIsDefault:  settings.encounterDurationSeconds === null,
    maxParticipants:             resolved.maxParticipants,
    maxParticipantsIsDefault:    settings.maxParticipants === null,
    // expose defaults so the UI can show them
    defaultEncounterDurationSeconds: defaultDuration,
    defaultMaxParticipants:          defaultMaxParticipants,
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
    questionsEnabled?: boolean
    encounterDurationSeconds?: number | null
    maxParticipants?: number | null
  }>()

  // Validate name separately — it is a top-level column, not part of settings JSON
  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 40)
    if (!name) return c.json({ error: 'name cannot be empty' }, 400)
    await c.env.DB.prepare('UPDATE rooms SET name = ? WHERE id = ?').bind(name, roomId).run()
  }

  // Validate numeric settings
  if (body.encounterDurationSeconds !== null && body.encounterDurationSeconds !== undefined) {
    const v = body.encounterDurationSeconds
    if (!Number.isInteger(v) || v < 1 || v > MAX_ENCOUNTER_DURATION_SECONDS) {
      return c.json({ error: `encounterDurationSeconds must be an integer between 1 and ${MAX_ENCOUNTER_DURATION_SECONDS}` }, 400)
    }
  }
  if (body.maxParticipants !== null && body.maxParticipants !== undefined) {
    const v = body.maxParticipants
    if (!Number.isInteger(v) || v < 1) {
      return c.json({ error: 'maxParticipants must be an integer >= 1' }, 400)
    }
  }

  // Merge incoming fields into the existing settings blob
  const existing = await c.env.DB.prepare(
    'SELECT settings FROM rooms WHERE id = ?'
  ).bind(roomId).first<{ settings: string }>()
  if (!existing) return c.json({ error: 'Room not found' }, 404)

  const current = parseSettings(existing.settings)
  const updated: RoomSettings = {
    isOpen:                   body.isOpen                   ?? current.isOpen,
    questionsEnabled:         body.questionsEnabled         ?? current.questionsEnabled,
    encounterDurationSeconds: body.encounterDurationSeconds !== undefined
                                ? body.encounterDurationSeconds
                                : current.encounterDurationSeconds,
    maxParticipants:          body.maxParticipants !== undefined
                                ? body.maxParticipants
                                : current.maxParticipants,
  }

  await c.env.DB.prepare(
    'UPDATE rooms SET settings = ? WHERE id = ?'
  ).bind(JSON.stringify(updated), roomId).run()

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

// ── Question management ──

// GET /api/admin/rooms/:roomId/questions
admin.get('/rooms/:roomId/questions', async (c) => {
  if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
  const roomId = c.req.param('roomId')

  const rows = await c.env.DB.prepare(
    'SELECT id, text FROM questions WHERE room_id = ? ORDER BY created_at ASC'
  ).bind(roomId).all<{ id: string; text: string }>()

  return c.json({ questions: rows.results })
})

// POST /api/admin/rooms/:roomId/questions
// Body: { text: string }
admin.post('/rooms/:roomId/questions', async (c) => {
  if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
  const roomId = c.req.param('roomId')
  const body = await c.req.json<{ text?: string }>()
  const text = body.text?.trim().slice(0, 200)
  if (!text) return c.json({ error: 'text is required' }, 400)

  const id = newPublicId()
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    'INSERT INTO questions (id, room_id, text, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, roomId, text, now).run()

  console.info('admin.question.added', { room: roomId, id })
  return c.json({ id, text }, 201)
})

// DELETE /api/admin/rooms/:roomId/questions/:qid
admin.delete('/rooms/:roomId/questions/:qid', async (c) => {
  if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
  const roomId = c.req.param('roomId')
  const qid    = c.req.param('qid')

  await c.env.DB.prepare(
    'DELETE FROM questions WHERE id = ? AND room_id = ?'
  ).bind(qid, roomId).run()

  console.info('admin.question.deleted', { room: roomId, id: qid })
  return c.json({ ok: true })
})

export default admin
