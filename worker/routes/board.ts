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
import { parseSettings } from '../lib/settings'

const board = new Hono<{ Bindings: Env }>()

// GET /api/rooms/:roomId/board/scores — public, top N (admin-configurable)
board.get('/scores', async (c) => {
  const roomId = c.req.param('roomId') as string
  const room = await c.env.DB.prepare(
    'SELECT id, name, expires_at, settings FROM rooms WHERE id = ?'
  ).bind(roomId).first<{ id: string; name: string; expires_at: number; settings: string }>()
  if (!room) return c.json({ error: 'Room not found' }, 404)

  const topSize = parseSettings(room.settings).boardTopSize

  const scores = await c.env.DB.prepare(`
    SELECT
      u.public_id,
      u.display_name,
      u.emoji,
      COUNT(CASE WHEN e.counted = 1 THEN 1 END) as meetings,
      (SELECT COUNT(*) FROM treasure_scans ts WHERE ts.user_id = u.public_id) as treasures,
      (SELECT COALESCE(SUM(ts.points), 0) FROM treasure_scans ts WHERE ts.user_id = u.public_id) as treasure_points,
      COUNT(CASE WHEN e.counted = 1 THEN 1 END)
        + (SELECT COALESCE(SUM(ts.points), 0) FROM treasure_scans ts WHERE ts.user_id = u.public_id) as score
    FROM users u
    LEFT JOIN encounters e
      ON e.room_id = u.room_id
      AND (e.user_a_id = u.public_id OR e.user_b_id = u.public_id)
    WHERE u.room_id = ?
    GROUP BY u.public_id
    ORDER BY score DESC, u.created_at ASC
    LIMIT ?
  `).bind(roomId, topSize).all()

  const totalUsers = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM users WHERE room_id = ?'
  ).bind(roomId).first<{ count: number }>()

  // Count meetings server-side over ALL encounters — the leaderboard is capped at
  // boardTopSize rows, so summing the returned `meetings` client-side would undercount.
  const totalMeetings = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM encounters WHERE room_id = ? AND counted = 1'
  ).bind(roomId).first<{ count: number }>()

  return c.json({ scores: scores.results, totalParticipants: totalUsers?.count ?? 0, totalMeetings: totalMeetings?.count ?? 0, boardTopSize: topSize, roomName: room.name, expiresAt: room.expires_at })
})

// GET /api/rooms/:roomId/board/graph — public, all nodes & edges
board.get('/graph', async (c) => {
  const roomId = c.req.param('roomId') as string
  const room = await c.env.DB.prepare(
    'SELECT id FROM rooms WHERE id = ?'
  ).bind(roomId).first()
  if (!room) return c.json({ error: 'Room not found' }, 404)

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

// GET /api/rooms/:roomId/board/ws — WebSocket for real-time leaderboard/graph updates
board.get('/ws', async (c) => {
  const roomId = c.req.param('roomId') as string
  const room = await c.env.DB.prepare(
    'SELECT id FROM rooms WHERE id = ?'
  ).bind(roomId).first()
  if (!room) return c.json({ error: 'Room not found' }, 404)

  const doId = c.env.DURABLE_ROOM.idFromName(roomId)
  const stub = c.env.DURABLE_ROOM.get(doId)
  const wsUrl = new URL(c.req.url)
  wsUrl.pathname = '/board-ws'
  return stub.fetch(new Request(wsUrl.toString(), c.req.raw))
})

export default board
