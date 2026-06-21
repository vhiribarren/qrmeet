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

const PREFIX = 'qrmeet.'

// Keys for the single active *player* session. Cleared on "Reset game".
// Admin credentials are intentionally NOT here — they live in the independent
// admin keychain below, so resetting the game never logs the organiser out of
// their rooms (and vice-versa).
const SESSION_KEYS = ['publicId', 'privateToken', 'roomId', 'displayName', 'emoji', 'qrToken']

export const storage = {
  get:    (key)        => localStorage.getItem(PREFIX + key),
  set:    (key, value) => localStorage.setItem(PREFIX + key, value),
  remove: (key)        => localStorage.removeItem(PREFIX + key),
  clearSession: ()     => SESSION_KEYS.forEach(k => localStorage.removeItem(PREFIX + k)),
}

// ── Admin keychain ──
// A device may administer several rooms at once, independently of any player
// session. Stored as a single JSON map { "<roomId>": { name, token } } where
// `token` is the hashed admin credential. This is the source of truth for the
// /admin console.
const KEYCHAIN_KEY = PREFIX + 'adminKeychain'

export const adminKeychain = {
  all:    ()                => { try { return JSON.parse(localStorage.getItem(KEYCHAIN_KEY) || '{}') } catch { return {} } },
  get:    (roomId)          => adminKeychain.all()[roomId] || null,
  set:    (roomId, name, token) => {
    const map = adminKeychain.all()
    map[roomId] = { name: name || '', token }
    localStorage.setItem(KEYCHAIN_KEY, JSON.stringify(map))
  },
  remove: (roomId)          => {
    const map = adminKeychain.all()
    delete map[roomId]
    localStorage.setItem(KEYCHAIN_KEY, JSON.stringify(map))
  },
  list:   ()                => Object.entries(adminKeychain.all()).map(([id, v]) => ({ id, ...v })),
}
