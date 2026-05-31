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
import { Env } from './lib/types'
import rooms from './routes/rooms'
import users from './routes/users'
import scan from './routes/scan'
import admin from './routes/admin'
import board from './routes/board'

export { DurableRoom } from './durable/DurableRoom'
import { purgeRoom } from './lib/rooms'

const app = new Hono<{ Bindings: Env }>()

// Content Security Policy applied to HTML documents.
// - 'unsafe-eval' is required by Alpine.js 3, which evaluates its directive
//   expressions (x-show, @click, …) via the Function constructor.
// - https://cdn.jsdelivr.net is needed for the CDN scripts AND for
//   emoji-picker-element fetching its emoji data JSON at runtime (connect-src).
// - SRI (integrity) on the CDN <script> tags guarantees their content.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // 'unsafe-eval' required by Alpine.js; 'unsafe-inline' covers the inline bootstrap
  // script injected by Cloudflare's beacon (its hash changes with each CDN update).
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
  "connect-src 'self' https://cdn.jsdelivr.net https://cloudflareinsights.com",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ')

// Set CSP on HTML responses only (skips API JSON, static assets and WS upgrades).
app.use('*', async (c, next) => {
  await next()
  const contentType = c.res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) return
  // ASSETS responses have immutable headers, so rebuild the response to set them.
  const res = new Response(c.res.body, c.res)
  res.headers.set('Content-Security-Policy', CSP)
  c.res = res
})


// Always return JSON errors from API routes
app.onError((err, c) => {
  console.error('unhandled error', { url: c.req.url, error: err.message, stack: err.stack })
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

app.route('/api/rooms', rooms)
app.route('/api/rooms/:roomId/users', users)
app.route('/api/rooms/:roomId/scan', scan)
app.route('/api/rooms/:roomId/board', board)
app.route('/api/admin', admin)

// WebSocket: /api/rooms/:roomId/users/:uid/ws
// All connections go through DurableRoom
app.get('/api/rooms/:roomId/users/:uid/ws', async (c) => {
  const { roomId, uid } = c.req.param()
  // Browsers cannot set custom headers on WebSocket connections, so the private
  // token is carried in the Sec-WebSocket-Protocol header as the two subprotocol
  // values `qrmeet.token, <token>`. This keeps it out of the URL (and therefore
  // out of access/observability logs). Non-browser clients may use x-private-token.
  const subprotocols = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim())
  const protoToken = subprotocols[0] === 'qrmeet.token' ? subprotocols[1] : undefined
  const privateToken = c.req.header('x-private-token') ?? protoToken

  if (!privateToken) return c.json({ error: 'Unauthorized' }, 401)

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE public_id = ? AND private_token = ? AND room_id = ?'
  ).bind(uid, privateToken, roomId).first()
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Proxy to DurableRoom
  const doId = c.env.DURABLE_ROOM.idFromName(roomId)
  const stub = c.env.DURABLE_ROOM.get(doId)
  const wsUrl = new URL(c.req.url)
  wsUrl.pathname = '/ws'
  wsUrl.searchParams.delete('t') // never forward a token in the URL
  wsUrl.searchParams.set('userId', uid)

  return stub.fetch(new Request(wsUrl.toString(), c.req.raw))
})

// Admin page: /r/:roomId/admin
app.get('/r/:roomId/admin', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/admin.html'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

// Public board: /r/:roomId/board
app.get('/r/:roomId/board', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/board.html'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

// SPA fallback: /r/:roomId and /r/:roomId/scan/:uid → serve index.html
app.get('/r/*', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

// Serve static assets (frontend)
app.all('*', async (c) => {
  // Try the exact path first, then fall back to /index.html for SPA
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404) {
    const indexUrl = new URL(c.req.url)
    indexUrl.pathname = '/index.html'
    return c.env.ASSETS.fetch(new Request(indexUrl.toString(), c.req.raw))
  }
  return res
})

// Periodic cleanup of expired rooms (Cron Trigger).
// For every room past its 24h expires_at, deletes encounters → users → rooms
// (encounters has no ON DELETE CASCADE, by design) and wipes the room's Durable
// Object so its active-encounter table and alarm don't outlive the room.
const scheduled: ExportedHandlerScheduledHandler<Env> = async (_event, env, _ctx) => {
  const now = Math.floor(Date.now() / 1000)
  const expired = await env.DB.prepare(
    'SELECT id FROM rooms WHERE expires_at <= ?'
  ).bind(now).all<{ id: string }>()

  const count = expired.results.length
  if (count === 0) {
    console.info('cron.cleanup', { expired: 0 })
    return
  }

  for (const { id } of expired.results) {
    await purgeRoom(env.DB, env.DURABLE_ROOM, id)
  }
  console.info('cron.cleanup', { expired: count, rooms: expired.results.map(r => r.id) })
}

export default { fetch: app.fetch, scheduled }
