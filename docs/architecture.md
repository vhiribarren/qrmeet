# Architecture

## Project structure

```
qrmeet/
├── worker/          ← Cloudflare Worker (TypeScript)
│   ├── index.ts
│   ├── routes/
│   ├── durable/
│   └── lib/
├── public/          ← Static assets + frontend JS (Alpine.js)
├── migrations/      ← D1 SQL migrations
├── wrangler.toml
└── tsconfig.json
```

## Infrastructure

```
Browser (PWA, Alpine.js)
  │  REST + WebSocket
  ▼
Cloudflare Worker (Hono)
  ├── D1 (SQLite)       — rooms, users, encounters
  ├── KV (QR_TOKENS)    — single-use QR tokens (one per user, TTL 1h)
  └── Durable Objects (SQLite-backed)
        └── DurableRoom — one instance per room
              ├── WebSocket connections for ALL participants in the room
              ├── Tracks active encounters with independent timers
              └── Durable alarm on next encounter to expire
```

## D1 database schema

### `rooms`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 6-character random slug (e.g. `abc123`) |
| `name` | TEXT | Display name for the event |
| `admin_token_hash` | TEXT | SHA-256 of the admin password |
| `created_at` | INTEGER | Unix timestamp |
| `expires_at` | INTEGER | Unix timestamp, `created_at` + `ROOM_TTL_DAYS` (default 7 days) |

### `users`
| Column | Type | Description |
|---|---|---|
| `public_id` | TEXT PK | 12-character ID embedded in QR codes |
| `private_token` | TEXT UNIQUE | 32-character token stored only in `localStorage` |
| `room_id` | TEXT FK | Parent room |
| `display_name` | TEXT | Editable on the ID card |
| `emoji` | TEXT | Editable on the ID card |
| `created_at` | INTEGER | Unix timestamp |

### `encounters`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 12-character random ID |
| `room_id` | TEXT | Parent room |
| `user_a_id` / `user_b_id` | TEXT FK | Pair, always stored in lexicographic order |
| `started_at` | INTEGER | Unix timestamp of first scan |
| `notified_at` | INTEGER | Set by the Durable Object alarm when the timer elapses |
| `closed_at` | INTEGER | Set on confirmation scan |
| `counted` | INTEGER | `1` once both parties confirmed; used for scoring |

A `UNIQUE(room_id, user_a_id, user_b_id)` constraint prevents the same pair from starting a second session after completing one.

### `questions`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 12-character random ID |
| `room_id` | TEXT FK | Parent room (`ON DELETE CASCADE`) |
| `text` | TEXT | Question text (NULL for tombstone rows) |
| `default_slug` | TEXT | Slug of the default question being hidden (NULL for custom questions) |
| `is_default` | INTEGER | `1` = tombstone hiding a default question; `0` = custom question added by organiser |
| `created_at` | INTEGER | Unix timestamp |

Default questions are hardcoded in `worker/lib/questions.ts`. A row with `is_default = 1` records that the organiser has hidden the default question identified by `default_slug`. Custom questions have `is_default = 0` and a non-NULL `text`.

---

## KV namespace — `QR_TOKENS`

Two key patterns, both with a 1-hour TTL:

| Key pattern | Value | Purpose |
|---|---|---|
| `qrtoken:{roomId}:{publicId}` | opaque token string | Single-use QR token per user |
| `ratelimit:join:{roomId}:{ip}` | join count (integer as string) | Rate limiting joins per IP per room |

---

## DurableRoom SQLite schema

One SQLite database per room instance. Stores only currently active encounters — rows are removed once confirmed or expired.

| Column | Type | Description |
|---|---|---|
| `encounter_id` | TEXT PK | Matches `encounters.id` in D1 |
| `user_a_id` / `user_b_id` | TEXT | Participant IDs |
| `user_a_name` / `user_b_name` | TEXT | Cached display names for WebSocket pushes |
| `user_a_emoji` / `user_b_emoji` | TEXT | Cached emojis |
| `started_at` | INTEGER | Unix timestamp |
| `ends_at` | INTEGER | Unix timestamp — when the alarm fires |

---

## API reference

See [`docs/api.md`](api.md) for the full endpoint reference.

---

## Asset serving & CSP

`run_worker_first` is **not set** in `wrangler.toml` (defaults to `false`). Static assets (JS, CSS, images) are served directly from the Cloudflare edge without invoking the worker, which keeps latency low.

HTML pages are always routed through explicit worker handlers (`/r/:id`, `/r/:id/board`, `/r/:id/admin`), which is where the CSP middleware runs. Because browsers enforce CSP from the document response, this gives full security coverage without the overhead of running the worker for every asset request.

> If a future change needs the worker to intercept asset requests (e.g. to add headers to JS files), set `run_worker_first = true` in `[assets]`.

---

## Durable Object — `DurableRoom`

One instance per room, keyed by `roomId`. Uses SQLite-backed storage (`new_sqlite_classes`).

All users in a room maintain a persistent WebSocket connection to the same `DurableRoom` instance. Multiple encounters run in parallel with independent timers.

| Endpoint (internal) | Description |
|---|---|
| `GET /ws?userId=` | WebSocket upgrade; sends `session_start` if user has active encounter, else `connected` |
| `POST /start-encounter` | Registers a new encounter, notifies both users instantly, schedules alarm |
| `POST /confirm-encounter` | Marks encounter confirmed, notifies both users, removes from active list |
| `POST /notify` | Sends a message to specific users by ID |

**Timer management**: The DO maintains a SQLite table of active encounters. The alarm is always set to the earliest `endsAt`. When it fires, all expired encounters are processed (notified), then the alarm is rescheduled to the next one.

---

## Frontend conventions

### Stack

- **Alpine.js** — the only frontend framework. Do not introduce React, Vue, or any other component library.
- **Native ESM** — scripts are loaded as `type="module"` with relative imports. There is no bundler; files are served as-is from `public/`.
- **No TypeScript on the frontend** — frontend code is plain `.js`. Type safety is provided by the worker (TypeScript + `@cloudflare/workers-types`).

### localStorage

Always use the `storage` helper from `public/storage.js`. Never call `localStorage` directly.

```javascript
import { storage } from './storage.js'
storage.get('key')           // reads  qrmeet.key
storage.set('key', value)    // writes qrmeet.key
storage.clearSession()       // removes all qrmeet.* session keys
```

The `SESSION_KEYS` array in `storage.js` is the single source of truth for which keys are cleared on session reset.

### API error format

All API routes return errors as JSON with a consistent shape:

```json
{ "error": "Human-readable message" }
```

### Admin authentication

Every admin route handler must begin with:

```typescript
if (!await verifyAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
```

Never inline the auth check; always delegate to `verifyAdmin()` in `worker/routes/admin.ts`.

### Testing

There is no automated test suite. Correctness is verified manually using `npm run dev` and `npm run simulate`.

---

## Design decisions

### Client-side password hashing (double-hash)

The admin password is hashed client-side (SHA-256 via Web Crypto) before being sent to the server. The server then hashes the received value a second time before storing it.

- The plaintext password never leaves the browser.
- A leaked database reveals only a hash-of-hash, not the original password.
- `localStorage` holds the first hash (enough to authenticate), never the plaintext.

### Durable Objects for encounter timers

Encounter timers require a server-side alarm that fires reliably after N seconds, even if no client is connected. D1 (SQLite) is stateless and cannot self-schedule work. Durable Objects provide both persistent state and the `alarm()` primitive, making them the natural fit. Each room gets one DO instance, so timers are isolated per room and scale independently.

### Single-use QR tokens in KV

QR tokens are stored in KV (not D1) with a 1-hour TTL for two reasons:
- **Atomicity**: KV writes are fast and TTL-based expiry is automatic — no cron needed.
- **Single-use enforcement**: the token is deleted on first successful scan, preventing replay attacks without a separate "used" flag.

### No `ON DELETE CASCADE` on encounters

The `encounters` table references `users(public_id)` without `CASCADE`. Deleting a user therefore requires explicitly deleting their encounters first (done in the admin delete route). This is intentional: it avoids silent data loss if a delete is triggered by mistake, and keeps the migration schema simple.

### Scheduled cleanup of expired rooms

Rooms carry an `expires_at` (`created_at` + `ROOM_TTL_DAYS`, default 7 days). An hourly **Cron Trigger** (`[triggers].crons` in `wrangler.toml`, handled by `scheduled()` in `worker/index.ts`) deletes every expired room and all of its data: encounters → users → rooms in D1 (in that order, since encounters has no `ON DELETE CASCADE`), then a `POST /cleanup` to the room's Durable Object, which clears its `active_encounters` table and cancels any pending alarm.

This is the single mechanism that bounds data retention. Consequences:
- Personal data lives at most `ROOM_TTL_DAYS` (default 7 days) + up to 1h (next cron tick) — matching the Privacy notice. The board and admin pages display a live countdown to the deletion time (`expiresAt`).
- The Durable Object's `active_encounters` table cannot outlive its room, so abandoned (timed-out, never confirmed) encounters cannot accumulate indefinitely.
- `expires_at` is **not** enforced on the request path: between expiry and the next cron tick a room stays usable (scan/board/admin). This is an accepted trade-off (an expired room means the event is over) that keeps the hot `scan` path free of an extra room lookup.

> Known limit: within a single very large, very active room, timed-out-but-unconfirmed encounters still accumulate in the Durable Object until the room is cleaned up. If this becomes a problem, add a `purge_at` grace window to `active_encounters` and purge from the `alarm()` handler.
