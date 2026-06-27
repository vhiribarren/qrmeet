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
import { Env, User, Treasure } from '../lib/types'
import type { DurableRoom } from '../durable/DurableRoom'
import { newPublicId } from '../lib/ids'
import { extractPrivateToken } from '../lib/auth'
import { parseSettings } from '../lib/settings'

const treasures = new Hono<{ Bindings: Env }>()

// POST /api/rooms/:roomId/treasures/:treasureId/claim
// No body. Header: x-private-token (scanner's token).
// Awards the treasure's points to the scanner once. No conversation is started.
treasures.post('/:treasureId/claim', async (c) => {
  const roomId = c.req.param('roomId') as string
  const treasureId = c.req.param('treasureId') as string

  const scannerToken = await extractPrivateToken(c.req.raw)
  if (!scannerToken) return c.json({ error: 'Unauthorized' }, 401)

  const scanner = await c.env.DB.prepare(
    'SELECT * FROM users WHERE private_token = ? AND room_id = ?'
  ).bind(scannerToken, roomId).first<User>()
  if (!scanner) return c.json({ error: 'Unauthorized' }, 401)

  // Treasure hunt must be enabled for the room
  const room = await c.env.DB.prepare(
    'SELECT settings FROM rooms WHERE id = ?'
  ).bind(roomId).first<{ settings: string }>()
  if (!room) return c.json({ error: 'Room not found' }, 404)
  const settings = parseSettings(room.settings)
  if (!settings.scanningEnabled) {
    return c.json({ error: 'The organizer has paused the game — scanning is disabled for now. Please wait until it resumes.' }, 403)
  }
  if (!settings.treasureHuntEnabled) {
    return c.json({ error: 'Treasure hunt is not active in this room.' }, 403)
  }

  // Treasure must exist, belong to the room, and be enabled
  const treasure = await c.env.DB.prepare(
    'SELECT * FROM treasures WHERE id = ? AND room_id = ?'
  ).bind(treasureId, roomId).first<Treasure>()
  if (!treasure) return c.json({ error: 'This treasure does not exist.' }, 404)
  if (treasure.enabled !== 1) {
    return c.json({ error: 'This treasure is currently disabled.' }, 403)
  }

  // Resolve awarded points: per-treasure override, else room default. Snapshot it.
  const points = treasure.points ?? settings.treasureDefaultPoints

  const scanId = newPublicId()
  const now = Math.floor(Date.now() / 1000)
  try {
    await c.env.DB.prepare(
      'INSERT INTO treasure_scans (id, room_id, treasure_id, user_id, points, scanned_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(scanId, roomId, treasureId, scanner.public_id, points, now).run()
  } catch (e) {
    // UNIQUE(treasure_id, user_id) — this player already collected this treasure.
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      return c.json({ action: 'already_claimed', label: treasure.label })
    }
    throw e
  }

  // Refresh any open leaderboards.
  const stub = c.env.DURABLE_ROOM.get(c.env.DURABLE_ROOM.idFromName(roomId)) as unknown as DurableObjectStub<DurableRoom>
  await stub.broadcastBoardUpdate()

  console.info('treasure.claimed', { room: roomId, treasure: treasureId, user: scanner.public_id, points })
  return c.json({ action: 'claimed', points, label: treasure.label })
})

export default treasures
