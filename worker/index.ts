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
import treasures from './routes/treasures'
import admin from './routes/admin'
import board from './routes/board'
import frontend from './routes/frontend'

export { DurableRoom } from './durable/DurableRoom'
import { purgeRoom } from './lib/rooms'
import { csp } from './middleware/csp'
import { servePage } from './lib/assets'

const app = new Hono<{ Bindings: Env }>()

// Content Security Policy applied to HTML documents.
// - 'unsafe-eval' is required by Alpine.js 3, which evaluates its directive
//   expressions (x-show, @click, …) via the Function constructor.
// - https://cdn.jsdelivr.net is needed for the CDN scripts AND for
//   emoji-picker-element fetching its emoji data JSON at runtime (connect-src).
// - SRI (integrity) on the CDN <script> tags guarantees their content.
const CSP_DIRECTIVES = [
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
]

app.use('*', csp(CSP_DIRECTIVES))

// Always return JSON errors from API routes
app.onError((err, c) => {
  console.error('unhandled error', { url: c.req.url, error: err.message, stack: err.stack })
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

app.route('/api/rooms', rooms)
app.route('/api/rooms/:roomId/users', users)
app.route('/api/rooms/:roomId/scan', scan)
app.route('/api/rooms/:roomId/treasures', treasures)
app.route('/api/rooms/:roomId/board', board)
app.route('/api/admin', admin)
app.route('/r', frontend)

// Admin console: device-local launcher listing every room the organiser
// administers. Routed through the worker (not a native asset fallback) so the
// CSP middleware applies, like the other HTML pages.
app.get('/admin', (c) => servePage(c, 'admin.html'))

// Explicitly serve index.html for the root path.
// We cannot rely on Wrangler's native SPA routing (`not_found_handling = "single-page-application"`)
// because native asset fallbacks bypass the worker entirely. This would result in the edge
// serving index.html *without* passing through our CSP middleware, breaking the security model.
app.get('/', (c) => servePage(c, 'index.html'))

// Serve static assets (CSS, JS, images) via the worker in local dev (`wrangler dev`).
// In production (`run_worker_first = false`), this block only catches invalid routes and cleanly returns a 404.
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
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
