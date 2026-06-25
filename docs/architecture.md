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
  ├── KV (QRMEET_TOKENS)    — single-use QR tokens (one per user, TTL 1h)
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
| `private_token` | TEXT UNIQUE | Client-generated bearer token (256-bit hex), stored only in `localStorage`. Also the join idempotency key (see `POST /users` in `api.md`) — the `UNIQUE` constraint backs `INSERT … ON CONFLICT(private_token)` so concurrent first-joins from one device resolve to a single account |
| `room_id` | TEXT FK | Parent room |
| `display_name` | TEXT | Editable on the ID card |
| `emoji` | TEXT | Editable on the ID card |
| `ip_hash` | TEXT | HMAC of the joining IP (salted per room). Surfaced as the admin `network_tag` for spotting bot/duplicate accounts — **not** used to deduplicate joins |
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

### `treasures` (treasure hunt mode)
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 12-character random ID — also the capability embedded in the printed QR (`/r/:roomId/treasure/:id`) |
| `room_id` | TEXT FK | Parent room (`ON DELETE CASCADE`) |
| `label` | TEXT | Admin-facing label (printed on the QR sheet) |
| `points` | INTEGER | `NULL` = inherit the room's `treasureDefaultPoints`; a number overrides it |
| `enabled` | INTEGER | `1` = scannable, `0` = disabled |
| `created_at` | INTEGER | Unix timestamp |

### `treasure_scans`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 12-character random ID |
| `room_id` | TEXT | Parent room |
| `treasure_id` | TEXT FK | The treasure that was scanned |
| `user_id` | TEXT FK | The player who claimed it |
| `points` | INTEGER | **Snapshot** of points awarded — later changing the default/override never rewrites it |
| `scanned_at` | INTEGER | Unix timestamp |

A `UNIQUE(treasure_id, user_id)` constraint enforces **one claim per player per treasure**.

**Unified scoring.** A user's score is `COUNT(counted encounters) + SUM(treasure_scans.points)`, computed via a correlated subquery in the board, admin, and user score endpoints. The admin dashboard's "Meetings" stat uses the encounter-only count so treasure points don't inflate it.

**Treasure mode settings** live in the `rooms.settings` JSON blob (see `worker/lib/settings.ts`): `treasureHuntEnabled` (default `false`) and `treasureDefaultPoints` (default `3`). No schema migration is needed to add settings.

---

## KV namespace — `QRMEET_TOKENS`

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

The `SESSION_KEYS` array in `storage.js` is the single source of truth for which keys are cleared on session reset. It holds **only the player session** (`publicId`, `privateToken`, `roomId`, `displayName`, `emoji`, `qrToken`).

### Admin keychain

Admin credentials are **not** part of the player session — they live in an independent keychain so that resetting the game never logs the organiser out of their rooms, and a device can be both a player (in one room) and an admin (of several rooms) at the same time.

```javascript
import { adminKeychain } from './storage.js'
adminKeychain.set(roomId, name, token)  // add/refresh a room
adminKeychain.get(roomId)               // { name, token } | null
adminKeychain.list()                    // [{ id, name, token }, …]
adminKeychain.remove(roomId)            // forget on this device (room not deleted)
```

It is stored as a single JSON map under `qrmeet.adminKeychain` = `{ "<roomId>": { name, token } }`, where `token` is the hashed admin credential (the same value sent as `x-admin-token`). The keychain is the source of truth for the `/admin` console.

Because the credential *is* the hashed password, no cross-device sync is needed: the organiser re-adds a room on any device via `/admin` → "Add an existing room" (code + password) — there is no global account.

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

Automated tests run with **Vitest** on the `@cloudflare/vitest-pool-workers` pool — tests
execute inside the real `workerd` runtime with live D1/KV/Durable Object bindings, and each
test gets isolated storage seeded from the project migrations (`test/apply-migrations.ts`
applies `migrations/` via `readD1Migrations`). Two layers, under `test/`:

- **Unit** (`test/unit/`): pure helpers — `settings`, `ids`, `questions`, `auth`.
- **Integration** (`test/integration/`): the Hono routes end-to-end via `SELF.fetch()` with
  real bindings — rooms, users, the scan/encounter lifecycle, treasure hunt, admin (auth,
  settings, treasure CRUD, renew, purge), and the public board's unified scoring.

Run with `npm test` (`npm run test:watch` to watch). The confirm-scan path marks the encounter
timer elapsed directly in D1 (the same `UPDATE` the DurableRoom alarm runs) so it is
deterministic without waiting. WebSocket endpoints and the Alpine front-end are **not** covered
by the suite; `scripts/simulate.ts` remains a manual load/smoke tool (`npm run simulate`).

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

The `encounters` table references `users(public_id)` without `CASCADE`. Deleting a user therefore requires explicitly deleting their encounters first (done in the admin delete route). This is intentional: it avoids silent data loss if a delete is triggered by mistake, and keeps the migration schema simple. The same applies to `treasure_scans`: the admin user-delete route removes a user's treasure scans before the user row, and `purgeRoom()` deletes `treasure_scans` and `treasures` alongside encounters/users.

### Treasure id as capability (no separate secret)

Treasure QR codes are static (printed once) and encode `/r/:roomId/treasure/:treasureId`. The `id` is a 12-character random slug (~36¹² ≈ 4.7×10¹⁸ combinations), so it is itself an unguessable capability — there is **no** separate secret column or rotating KV token like the per-user QR flow. The QR is public by design (whoever physically finds it may scan), so the only conceivable attack is guessing an id without finding the code, which the id's entropy makes infeasible. Re-printing simply re-renders the same stable URL.

### Scheduled cleanup of expired rooms

Rooms carry an `expires_at` (`created_at` + `ROOM_TTL_DAYS`, default 7 days). An hourly **Cron Trigger** (`[triggers].crons` in `wrangler.toml`, handled by `scheduled()` in `worker/index.ts`) deletes every expired room and all of its data: treasure_scans → treasures → encounters → users → rooms in D1 (in that order, since these tables have no `ON DELETE CASCADE` to the room), then a `POST /cleanup` to the room's Durable Object, which clears its `active_encounters` table and cancels any pending alarm.

This is the single mechanism that bounds data retention. Consequences:
- Personal data lives at most `ROOM_TTL_DAYS` (default 7 days) + up to 1h (next cron tick) — matching the Privacy notice. The board and admin pages display a live countdown to the deletion time (`expiresAt`).
- The Durable Object's `active_encounters` table cannot outlive its room, so abandoned (timed-out, never confirmed) encounters cannot accumulate indefinitely.
- `expires_at` is **not** enforced on the request path: between expiry and the next cron tick a room stays usable (scan/board/admin). This is an accepted trade-off (an expired room means the event is over) that keeps the hot `scan` path free of an extra room lookup.

> Known limit: within a single very large, very active room, timed-out-but-unconfirmed encounters still accumulate in the Durable Object until the room is cleaned up. If this becomes a problem, add a `purge_at` grace window to `active_encounters` and purge from the `alarm()` handler.
