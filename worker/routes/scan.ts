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
import { Env, User, Encounter } from '../lib/types'
import type { DurableRoom } from '../durable/DurableRoom'
import { newEncounterId } from '../lib/ids'
import { extractPrivateToken } from '../lib/auth'
import { pickTwoQuestions } from '../lib/questions'
import { parseSettings, resolveSettings } from '../lib/settings'

const scan = new Hono<{ Bindings: Env }>()

// POST /api/rooms/:roomId/scan
// Body: { scanneePublicId, qrToken }
// Header: x-private-token (scanner's token)
function roomIdFromUrl(url: string): string {
  const m = url.match(/\/api\/rooms\/([^/]+)\//)
  return m?.[1] ?? ''
}

scan.post('/', async (c) => {
  const roomId = (c.req.param('roomId') as string | undefined) || roomIdFromUrl(c.req.url)
  const scannerToken = await extractPrivateToken(c.req.raw)
  if (!scannerToken) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ scanneePublicId: string; qrToken: string }>()
  if (!body.scanneePublicId || !body.qrToken) {
    return c.json({ error: 'scanneePublicId and qrToken required' }, 400)
  }

  // Game switch: when the organizer pauses the game, no scan can proceed —
  // neither starting a new encounter nor confirming an existing one.
  const room = await c.env.DB.prepare(
    'SELECT settings FROM rooms WHERE id = ?'
  ).bind(roomId).first<{ settings: string }>()
  const settings = parseSettings(room?.settings)
  if (!settings.scanningEnabled) {
    return c.json({ error: 'The organizer has paused the game — scanning is disabled for now. Please wait until it resumes.' }, 403)
  }

  // Verify scanner
  const scanner = await c.env.DB.prepare(
    'SELECT * FROM users WHERE private_token = ? AND room_id = ?'
  ).bind(scannerToken, roomId).first<User>()
  if (!scanner) return c.json({ error: 'Unauthorized' }, 401)

  // Cannot scan yourself
  if (scanner.public_id === body.scanneePublicId) {
    return c.json({ error: 'Cannot scan yourself' }, 400)
  }

  // Verify scannee exists
  const scannee = await c.env.DB.prepare(
    'SELECT * FROM users WHERE public_id = ? AND room_id = ?'
  ).bind(body.scanneePublicId, roomId).first<User>()
  if (!scannee) return c.json({ error: 'User not found' }, 404)

  // Verify QR token (not burned yet — only burn if we're going to proceed).
  // The token lives on the scannee's users row (strongly consistent in D1), so a
  // freshly issued token is never read back stale the way it could be from KV.
  if (!scannee.qr_token || scannee.qr_token !== body.qrToken) {
    return c.json({ error: 'Invalid or expired QR code. Ask them to refresh their card.' }, 400)
  }

  // Normalize pair order for UNIQUE constraint (always smaller id first)
  const [userA, userB] = [scanner.public_id, scannee.public_id].sort()
  const userARecord = userA === scanner.public_id ? scanner : scannee
  const userBRecord = userB === scanner.public_id ? scanner : scannee

  // Check for existing encounter between them
  const existing = await c.env.DB.prepare(
    'SELECT * FROM encounters WHERE room_id = ? AND user_a_id = ? AND user_b_id = ?'
  ).bind(roomId, userA, userB).first<Encounter>()

  if (existing) {
    if (existing.counted === 1) {
      return c.json({ error: 'You already completed a session with this person.' }, 409)
    }
    if (!existing.notified_at) {
      return c.json({ error: 'Session still in progress — come back after the 5 minutes are up.' }, 409)
    }

    // Timer elapsed and notified — burn token and confirm
    await c.env.DB.prepare(
      'UPDATE users SET qr_token = NULL WHERE public_id = ?'
    ).bind(scannee.public_id).run()
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      'UPDATE encounters SET counted = 1, closed_at = ? WHERE id = ?'
    ).bind(now, existing.id).run()
    const confirmStub = c.env.DURABLE_ROOM.get(c.env.DURABLE_ROOM.idFromName(roomId)) as unknown as DurableObjectStub<DurableRoom>
    await confirmStub.confirmEncounter(existing.id)
    console.info('encounter.confirmed', { room: roomId, encounter: existing.id, userA, userB })
    return c.json({ action: 'confirmed', encounterId: existing.id })
  }

  // Guard: a user can only hold one active conversation at a time. Block if the
  // scanner or the scannee is already in an encounter whose timer is still running
  // (notified_at IS NULL, counted 0) with a third party. We only reach this point
  // when there is no existing scanner↔scannee encounter, so any match here is with
  // someone else. Don't burn the QR token — the scannee's card must stay valid.
  const busy = await c.env.DB.prepare(
    `SELECT user_a_id, user_b_id FROM encounters
     WHERE room_id = ? AND notified_at IS NULL AND counted = 0
       AND (user_a_id IN (?, ?) OR user_b_id IN (?, ?))
     LIMIT 1`
  ).bind(roomId, scanner.public_id, scannee.public_id, scanner.public_id, scannee.public_id)
    .first<{ user_a_id: string; user_b_id: string }>()

  if (busy) {
    const scannerBusy = busy.user_a_id === scanner.public_id || busy.user_b_id === scanner.public_id
    console.info('encounter.busy', { room: roomId, scanner: scanner.public_id, scannee: scannee.public_id, scannerBusy })
    return c.json({
      error: scannerBusy
        ? "You're already in a conversation — finish it before scanning someone new."
        : 'This person is already in a conversation with someone else. Try again in a moment.',
    }, 409)
  }

  // New encounter — burn token
  await c.env.DB.prepare(
    'UPDATE users SET qr_token = NULL WHERE public_id = ?'
  ).bind(scannee.public_id).run()
  const encId = newEncounterId()
  const now = Math.floor(Date.now() / 1000)
  const resolved = resolveSettings(settings, c.env)
  const duration = resolved.encounterDurationSeconds

  try {
    await c.env.DB.prepare(
      'INSERT INTO encounters (id, room_id, user_a_id, user_b_id, started_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(encId, roomId, userA, userB, now).run()
  } catch (e) {
    // A concurrent scan of the same pair (e.g. both people scanning each other at
    // once) may have already created the encounter, violating the
    // UNIQUE(room_id, user_a_id, user_b_id) constraint. Treat it as success: the
    // session is now active and both clients are notified over WebSocket by the
    // request that won the race.
    if (!(e instanceof Error && /UNIQUE/i.test(e.message))) throw e

    console.warn('encounter.concurrent', { room: roomId, userA, userB })
    const concurrent = await c.env.DB.prepare(
      'SELECT * FROM encounters WHERE room_id = ? AND user_a_id = ? AND user_b_id = ?'
    ).bind(roomId, userA, userB).first<Encounter>()

    if (concurrent && concurrent.counted === 0) {
      return c.json({
        action: 'started',
        encounterId: concurrent.id,
        endsAt: concurrent.started_at + duration,
        serverTime: now,
        partner: {
          publicId: scannee.public_id,
          displayName: scannee.display_name,
          emoji: scannee.emoji,
        },
      })
    }
    return c.json({ error: 'You already completed a session with this person.' }, 409)
  }

  const startStub = c.env.DURABLE_ROOM.get(c.env.DURABLE_ROOM.idFromName(roomId)) as unknown as DurableObjectStub<DurableRoom>
  let questionA = ''
  let questionB = ''
  if (resolved.questionsEnabled) {
    const rows = await c.env.DB.prepare(
      'SELECT text FROM questions WHERE room_id = ? ORDER BY RANDOM() LIMIT 2'
    ).bind(roomId).all<{ text: string }>()
    ;[questionA, questionB] = pickTwoQuestions(rows.results)
  }
  await startStub.startEncounter({
    encounterId: encId,
    userAId: userA,
    userBId: userB,
    userAName: userARecord.display_name,
    userAEmoji: userARecord.emoji,
    userBName: userBRecord.display_name,
    userBEmoji: userBRecord.emoji,
    startedAt: now,
    endsAt: now + duration,
    questionA,
    questionB,
  })
  console.info('encounter.started', { room: roomId, encounter: encId, userA, userB, endsAt: now + duration })

  return c.json({
    action: 'started',
    encounterId: encId,
    endsAt: now + duration,
    serverTime: now,
    partner: {
      publicId: scannee.public_id,
      displayName: scannee.display_name,
      emoji: scannee.emoji,
    },
  })
})

export default scan
