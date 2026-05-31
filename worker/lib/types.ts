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

export interface Env {
  DB: D1Database
  QR_TOKENS: KVNamespace
  DURABLE_ROOM: DurableObjectNamespace
  ASSETS: Fetcher
  ENCOUNTER_DURATION_SECONDS: string
  MAX_PARTICIPANTS: string
  ROOM_TTL_DAYS: string
}

export interface Room {
  id: string
  name: string
  admin_token_hash: string
  created_at: number
  expires_at: number
  encounter_duration_seconds: number | null
  max_participants: number | null
  is_open: number
}

export interface User {
  public_id: string
  private_token: string
  room_id: string
  display_name: string
  emoji: string
  created_at: number
}

export interface Encounter {
  id: string
  room_id: string
  user_a_id: string
  user_b_id: string
  started_at: number
  notified_at: number | null
  closed_at: number | null
  counted: number
}

export interface WsMessage {
  type: 'session_start' | 'session_end' | 'session_confirmed' | 'token_refresh' | 'error'
  [key: string]: unknown
}
