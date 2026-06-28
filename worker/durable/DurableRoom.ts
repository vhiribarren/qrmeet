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

import { DurableObject } from 'cloudflare:workers'
import { Env } from '../lib/types'

export interface ActiveEncounter {
  encounterId: string
  userAId: string
  userBId: string
  userAName: string
  userAEmoji: string
  userBName: string
  userBEmoji: string
  startedAt: number
  endsAt: number
  questionA: string   // conversation prompt shown to user A
  questionB: string   // conversation prompt shown to user B
}

export class DurableRoom extends DurableObject<Env> {
  private encounters = new Map<string, ActiveEncounter>() // encounterId -> encounter
  private initialized = false

  private async ensureInitialized() {
    if (this.initialized) return
    this.initialized = true

    // Keepalive: answer client pings at the runtime level so idle WebSockets
    // (user and board) are not dropped by edge/NAT idle timeouts. The auto-
    // response is served without waking the DO from hibernation, so it costs no
    // duration. The pong is valid JSON so clients can parse it and ignore it.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    )

    // Create table if not exists (SQLite-backed DO)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_encounters (
        encounter_id TEXT PRIMARY KEY,
        user_a_id TEXT NOT NULL,
        user_b_id TEXT NOT NULL,
        user_a_name TEXT NOT NULL,
        user_a_emoji TEXT NOT NULL,
        user_b_name TEXT NOT NULL,
        user_b_emoji TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        question_a TEXT NOT NULL DEFAULT '',
        question_b TEXT NOT NULL DEFAULT ''
      )
    `)

    // Load active encounters into memory
    const rows = this.ctx.storage.sql.exec(
      'SELECT * FROM active_encounters'
    ).toArray()

    for (const row of rows) {
      this.encounters.set(row.encounter_id as string, {
        encounterId: row.encounter_id as string,
        userAId: row.user_a_id as string,
        userBId: row.user_b_id as string,
        userAName: row.user_a_name as string,
        userAEmoji: row.user_a_emoji as string,
        userBName: row.user_b_name as string,
        userBEmoji: row.user_b_emoji as string,
        startedAt: row.started_at as number,
        endsAt: row.ends_at as number,
        questionA: (row.question_a as string) ?? '',
        questionB: (row.question_b as string) ?? '',
      })
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized()
    const url = new URL(request.url)

    // WebSocket connection for a user
    if (url.pathname === '/ws') {
      const userId = url.searchParams.get('userId')
      if (!userId) return new Response('userId required', { status: 400 })
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 })
      }

      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server, [userId])

      // Send current session state if user has an active encounter
      const encounter = this.findEncounterForUser(userId)
      if (encounter) {
        const isA = userId === encounter.userAId
        server.send(JSON.stringify({
          type: 'session_start',
          encounterId: encounter.encounterId,
          endsAt: encounter.endsAt,
          serverTime: Math.floor(Date.now() / 1000),
          partnerName: isA ? encounter.userBName : encounter.userAName,
          partnerEmoji: isA ? encounter.userBEmoji : encounter.userAEmoji,
          question: isA ? encounter.questionA : encounter.questionB,
        }))
      } else {
        server.send(JSON.stringify({ type: 'connected' }))
      }

      // Echo back the negotiated subprotocol scheme (never the token itself) so
      // browsers that offered a subprotocol complete the handshake cleanly.
      const headers = new Headers()
      const offered = request.headers.get('sec-websocket-protocol')
      if (offered) {
        const selected = offered.split(',')[0].trim()
        if (selected) headers.set('Sec-WebSocket-Protocol', selected)
      }

      return new Response(null, { status: 101, webSocket: client, headers })
    }

    // WebSocket connection for a board viewer
    if (url.pathname === '/board-ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 })
      }
      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server, ['board'])
      server.send(JSON.stringify({ type: 'connected' }))
      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Not found', { status: 404 })
  }

  async startEncounter(data: ActiveEncounter): Promise<void> {
    await this.ensureInitialized()
    this.encounters.set(data.encounterId, data)

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO active_encounters
       (encounter_id, user_a_id, user_b_id, user_a_name, user_a_emoji, user_b_name, user_b_emoji, started_at, ends_at, question_a, question_b)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.encounterId, data.userAId, data.userBId,
      data.userAName, data.userAEmoji, data.userBName, data.userBEmoji,
      data.startedAt, data.endsAt, data.questionA, data.questionB
    )

    const now = Math.floor(Date.now() / 1000)
    const msgA = JSON.stringify({
      type: 'session_start',
      encounterId: data.encounterId,
      endsAt: data.endsAt,
      serverTime: now,
      partnerName: data.userBName,
      partnerEmoji: data.userBEmoji,
      question: data.questionA,
    })
    const msgB = JSON.stringify({
      type: 'session_start',
      encounterId: data.encounterId,
      endsAt: data.endsAt,
      serverTime: now,
      partnerName: data.userAName,
      partnerEmoji: data.userAEmoji,
      question: data.questionB,
    })
    this.sendToUser(data.userAId, msgA)
    this.sendToUser(data.userBId, msgB)

    await this.scheduleNextAlarm()
  }

  async confirmEncounter(encounterId: string): Promise<void> {
    await this.ensureInitialized()
    const encounter = this.encounters.get(encounterId)
    if (!encounter) return

    const msg = JSON.stringify({ type: 'session_confirmed', encounterId })
    this.sendToUser(encounter.userAId, msg)
    this.sendToUser(encounter.userBId, msg)

    this.encounters.delete(encounterId)
    this.ctx.storage.sql.exec(
      'DELETE FROM active_encounters WHERE encounter_id = ?',
      encounterId
    )
    await this.scheduleNextAlarm()
    this.broadcastToBoards({ type: 'board_update' })
  }

  async broadcastBoardUpdate(): Promise<void> {
    this.broadcastToBoards({ type: 'board_update' })
  }

  // Tell a single user their QR token was just burned server-side (someone
  // scanned them) so their client re-issues a fresh one. The new token is not
  // sent here: the client re-reads it from D1 — the source of truth — via the
  // /qr-token endpoint, exactly as it does on page load and on WS reconnect.
  async notifyTokenBurned(userId: string): Promise<void> {
    this.sendToUser(userId, JSON.stringify({ type: 'token_refresh' }))
  }

  async cleanup(): Promise<void> {
    await this.ensureInitialized()
    this.encounters.clear()
    this.ctx.storage.sql.exec('DELETE FROM active_encounters')
    await this.ctx.storage.deleteAlarm()
    console.info('room.cleanup', { room: this.ctx.id.name })
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized()
    const now = Math.floor(Date.now() / 1000)

    // Find all encounters that have expired
    const expired: ActiveEncounter[] = []
    for (const enc of this.encounters.values()) {
      if (enc.endsAt <= now) {
        expired.push(enc)
      }
    }

    for (const enc of expired) {
      await this.env.DB.prepare(
        'UPDATE encounters SET notified_at = ? WHERE id = ? AND notified_at IS NULL'
      ).bind(now, enc.encounterId).run()

      const msg = JSON.stringify({
        type: 'session_end',
        encounterId: enc.encounterId,
        message: 'Time is up! Scan each other again to confirm your meeting.',
      })
      this.sendToUser(enc.userAId, msg)
      this.sendToUser(enc.userBId, msg)
    }

    if (expired.length > 0) {
      console.info('encounter.alarm', {
        room: this.ctx.id.name,
        expired: expired.map(e => e.encounterId),
      })
    }

    await this.scheduleNextAlarm()
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Clients may send pings; ignore
  }

  webSocketClose(_ws: WebSocket, _code: number): void {
    // Hibernation handles cleanup
  }

  private findEncounterForUser(userId: string): ActiveEncounter | undefined {
    // A user can be tied to several encounters in the map at once: at most one
    // running conversation plus any number of expired-but-unconfirmed ones
    // (timer fired, never re-scanned). On reconnect we must restore the *active*
    // conversation — returning an expired one would leave the client on the QR
    // screen (sessionSecondsLeft <= 0) and hide the real conversation. Prefer a
    // still-running encounter; fall back to the most recent expired one so a
    // lone "time's up — scan to confirm" state is still surfaced.
    const now = Math.floor(Date.now() / 1000)
    let fallback: ActiveEncounter | undefined
    for (const enc of this.encounters.values()) {
      if (enc.userAId === userId || enc.userBId === userId) {
        if (enc.endsAt > now) return enc
        fallback = enc
      }
    }
    return fallback
  }

  private sendToUser(userId: string, message: string): void {
    const sockets = this.ctx.getWebSockets(userId)
    for (const ws of sockets) {
      try { ws.send(message) } catch {}
    }
  }

  private broadcastToBoards(message: object): void {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets('board')) {
      try { ws.send(payload) } catch {}
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (this.encounters.size === 0) return

    const now = Math.floor(Date.now() / 1000)
    // Find the earliest endsAt that hasn't expired yet
    let earliest = Infinity
    for (const enc of this.encounters.values()) {
      if (enc.endsAt > now && enc.endsAt < earliest) earliest = enc.endsAt
    }

    if (earliest < Infinity) {
      await this.ctx.storage.setAlarm(earliest * 1000)
    }
  }
}
