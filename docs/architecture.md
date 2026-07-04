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
  ├── D1 (SQLite)       — rooms, users (incl. single-use QR token), encounters
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
| `qr_token` | TEXT | Single-use scan token for this user's QR card. Overwritten on each refresh (`POST …/qr-token`), set `NULL` when burned by a scan. Lives in D1 (not KV) because the scan path is read-after-write critical and KV is only eventually consistent — a freshly issued token could otherwise read back stale and surface "Invalid or expired QR code". Single-use + constant rotation means no expiry is needed |

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

**Treasure mode settings** live in the `rooms.settings` JSON blob (see `worker/lib/settings.ts`): `treasureHuntEnabled` (default `true`) and `treasureDefaultPoints` (a plain per-room number, seeded at room creation from the `TREASURE_DEFAULT_POINTS` env var, default `2`, then editable). No schema migration is needed to add settings.

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

WebSocket upgrades go through the DO's `fetch()` handler (the only HTTP surface); everything else is a typed RPC method called on the stub from the worker routes.

| Internal endpoint (fetch) | Description |
|---|---|
| `GET /ws?userId=` | Player WebSocket upgrade; sends `session_start` if the user has an active encounter, else `connected` |
| `GET /board-ws` | Board-viewer WebSocket upgrade; receives `board_update` pushes |

| RPC method | Caller | Description |
|---|---|---|
| `startEncounter(data)` | scan route | Registers a new encounter, pushes `session_start` to both users, schedules the alarm |
| `confirmEncounter(encounterId)` | scan route | Pushes `session_confirmed` to both users, removes the encounter from the active list, refreshes boards |
| `removeUserEncounters(userId)` | admin user-delete route | Purges every active encounter involving a deleted user and pushes `session_cancelled` to both parties |
| `notifyTokenBurned(userId)` | scan route | Pushes `token_refresh` to the scanned user so their client re-issues a fresh QR token |
| `broadcastBoardUpdate()` | users & treasures routes | Pushes `board_update` to all board viewers (user joined, treasure claimed) |
| `cleanup()` | room deletion & cron | Clears the active-encounter table and cancels any pending alarm |

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

Automated tests run with **Vitest**, split into two projects (`test.projects` in
`vitest.config.ts`) so `npm test` runs both:

- **`workers`** — executes inside the real `workerd` runtime on the
  `@cloudflare/vitest-pool-workers` pool, with live D1/Durable Object bindings; each test gets
  isolated storage seeded from the project migrations (`test/apply-migrations.ts` applies
  `migrations/` via `readD1Migrations`). Two layers:
  - **Unit** (`test/unit/`): pure helpers — `settings`, `ids`, `questions`, `auth`.
  - **Integration** (`test/integration/`): the Hono routes end-to-end via `SELF.fetch()` with
    real bindings — rooms, users, the scan/encounter lifecycle, treasure hunt, admin (auth,
    settings, treasure CRUD, renew, purge), and the public board's unified scoring.
- **`frontend`** (`test/frontend/`, `happy-dom` environment): the Alpine factory from
  `public/app.js` (exported as `qrmeet()`) instantiated as a plain object with `fetch`/the
  clock/collaborators stubbed. It covers the deterministic-only client branches the Playwright
  e2e suite can't drive — the 409 mutual-scan reconciliation and clock-offset in `doScan`, each
  `handleWsMessage` branch, the camera-only `_handleScannedUrl` parser, the `refreshQrToken`
  retry timer (fake timers), and the pure helpers (`formatTime`, `genPrivateToken`,
  `hashPassword`).

Run all with `npm test` (`npm run test:watch` to watch; `npm run test:frontend` /
`test:workers` for a single project). The confirm-scan path marks the encounter timer elapsed
directly in D1 (the same `UPDATE` the DurableRoom alarm runs) so it is deterministic without
waiting.

#### End-to-end (`e2e/`, Playwright)

The Alpine front-end and the live WebSocket path are covered by a separate **Playwright**
suite under `e2e/`, run with `npm run test:e2e` (a `pretest:e2e` hook applies the migrations
to the local D1; Playwright then auto-starts `wrangler dev` on `:8787`). Each test drives one
or more real browser contexts — one per "phone" — so a scan is performed by navigating the
scan URL directly (the camera is never used, matching `init()`'s cold-deep-link path). Screens
are selected via `data-test` attributes (`testIdAttribute: 'data-test'`); live state (`me`,
`qrToken`, `wsStatus`, `scoreData`) is read from the Alpine component via `window.Alpine.$data`.
Shared fixtures live in `e2e/helpers.ts`. The suite is split by theme:

- **`encounter.spec.ts`** — the meeting mechanics: the **session screen appears for both roles**
  (scanner via the HTTP `started` response, scannee via the `session_start` push), confirmation,
  re-scan rejection, the busy guard, single-use QR tokens, `token_refresh`, the restore of a
  notified-but-unconfirmed session after reload (the DO keeps the encounter and re-pushes
  `session_start` until confirmed), and a paused game rejecting scans.
- **`session.spec.ts`** — identity, entry and connection lifecycle: join via the landing code
  input, resume from the landing page, profile-name persistence (server + localStorage), an
  active session surviving a reload, a stale session cleared on reconnect (the `connected`
  path), cross-room gating, and the reconnect indicator.
- **`treasure.spec.ts`** — the four treasure cases (cold auto-join vs. existing player, re-claim,
  cross-room).

Two things can't be tested deterministically through real browsers and are instead covered by
the `frontend` Vitest project: the simultaneous mutual-scan 409 race and the server/client
clock-offset adjustment in `doScan`. A real network drop also can't be simulated against
loopback (Chromium's offline emulation ignores localhost and `ws.close()` leaves the Durable
Object socket in `CLOSING`), so the connection test simulates the lost socket and asserts
`connectWs()` recovers the indicator.

`scripts/simulate.ts` remains a manual load/smoke tool (`npm run simulate`).

---

## Design decisions

### Client-side password hashing (double-hash)

The admin password is hashed client-side (SHA-256 via Web Crypto) before being sent to the server. The server then hashes the received value a second time before storing it.

- The plaintext password never leaves the browser.
- A leaked database reveals only a hash-of-hash, not the original password.
- `localStorage` holds the first hash (enough to authenticate), never the plaintext.

### Bearer tokens over session cookies

Auth is stateless bearer tokens, never cookies. The player `privateToken` and the admin credential travel in explicit headers (`x-private-token`, `x-admin-token`; the WebSocket handshake passes the token as the second `Sec-WebSocket-Protocol` value because browsers can't set headers on a WebSocket). They live in `localStorage` / the admin keychain, not in a `Set-Cookie` jar, and the server keeps **no** session table — a token is matched directly against `users.private_token` / `rooms.admin_token_hash`.

The deliberate trade-off vs. a server-managed `HttpOnly` cookie:

- **Given up — XSS resistance.** A token in `localStorage` is readable by any injected script; an `HttpOnly` cookie is not. Accepted: the protected asset is a player identity in an ephemeral game room (low value), the front-end ships no third-party scripts, and a CSP is enforced on every HTML response.
- **Kept — CSRF immunity for free.** A custom header can't be forged by a cross-site request, and the browser never attaches it automatically, so every state-changing endpoint (`scan`, treasure claim, profile, all admin routes) is CSRF-proof with no `SameSite`/origin/token machinery. A cookie sent automatically would reintroduce that surface — e.g. a third-party page could silently fire `DELETE …/rooms/:id` with the organiser's auto-attached credential. (Note: a victim *clicking a link* and acting under their own identity is plain navigation, not CSRF — that is unaffected either way.)
- **Kept — trivial multi-identity.** One device can be a player in one room and admin of several at once. Header tokens are just values chosen per request; a domain-scoped cookie would need per-room naming or a server-side session pivot.
- **Kept — client-owned join idempotency.** The client generates `privateToken` before joining, so `POST /users` is idempotent via the `UNIQUE(private_token)` constraint (see `api.md`). A server-issued cookie identity would need a separate idempotency key.
- **Kept — zero session state.** Nothing to expire, rotate, or garbage-collect; the credential *is* the identity (admin: the keychain stores the hashed password, so any device re-authenticates with code + password — no global account).

> If XSS resistance ever outweighs these, the admin credential (controls room settings and deletion) is the higher-value target and the better first candidate for an `HttpOnly` cookie — not the player token.

### Durable Objects for encounter timers

Encounter timers require a server-side alarm that fires reliably after N seconds, even if no client is connected. D1 (SQLite) is stateless and cannot self-schedule work. Durable Objects provide both persistent state and the `alarm()` primitive, making them the natural fit. Each room gets one DO instance, so timers are isolated per room and scale independently.

### Single-use QR tokens in D1

The per-user scan token lives in `users.qr_token` (D1), not KV. KV is only **eventually consistent**: a token written by `POST …/qr-token` can read back stale (or as the just-deleted value) from a different edge location for up to ~60 s. Since scan verification is read-after-write critical, that surfaced as "Invalid or expired QR code" on a QR the user had just refreshed. D1 is strongly consistent, so the freshly issued token is always visible.

Single-use enforcement is still cheap: the token is set `NULL` on first successful scan, preventing replay without a separate "used" flag. The consumption is atomic — the burn is a conditional `UPDATE … WHERE qr_token = ?` and the scan is rejected when it changes no row — so two people scanning the same displayed QR at the same instant cannot both start an encounter (a plain check-then-burn would let both pass the check *and* the busy guard, putting the scannee in two conversations at once). No expiry is needed — the token is single-use and rotated on every encounter event, and it lives on the existing user row (nothing to garbage-collect).

### No `ON DELETE CASCADE` on encounters

The `encounters` table references `users(public_id)` without `CASCADE`. Deleting a user therefore requires explicitly deleting their encounters first (done in the admin delete route). This is intentional: it avoids silent data loss if a delete is triggered by mistake, and keeps the migration schema simple. The same applies to `treasure_scans`: the admin user-delete route removes a user's treasure scans before the user row, and `purgeRoom()` deletes `treasure_scans` and `treasures` alongside encounters/users.

### Treasure id as capability (no separate secret)

Treasure QR codes are static (printed once) and encode `/r/:roomId/treasure/:treasureId`. The `id` is a 12-character random slug (~36¹² ≈ 4.7×10¹⁸ combinations), so it is itself an unguessable capability — there is **no** separate secret column or rotating KV token like the per-user QR flow. The QR is public by design (whoever physically finds it may scan), so the only conceivable attack is guessing an id without finding the code, which the id's entropy makes infeasible. Re-printing simply re-renders the same stable URL.

### Scheduled cleanup of expired rooms

Rooms carry an `expires_at` (`created_at` + `ROOM_TTL_DAYS`, default 7 days). An hourly **Cron Trigger** (`[triggers].crons` in `wrangler.toml`, handled by `scheduled()` in `worker/index.ts`) deletes every expired room and all of its data: treasure_scans → treasures → encounters → users → rooms in D1 (in that order, since these tables have no `ON DELETE CASCADE` to the room), then a `cleanup()` RPC call to the room's Durable Object, which clears its `active_encounters` table and cancels any pending alarm.

This is the single mechanism that bounds data retention. Consequences:
- Personal data lives at most `ROOM_TTL_DAYS` (default 7 days) + up to 1h (next cron tick) — matching the Privacy notice. The board and admin pages display a live countdown to the deletion time (`expiresAt`).
- The Durable Object's `active_encounters` table cannot outlive its room, so abandoned (timed-out, never confirmed) encounters cannot accumulate indefinitely.
- `expires_at` is **not** enforced on the request path: between expiry and the next cron tick a room stays usable (scan/board/admin). This is an accepted trade-off (an expired room means the event is over) that keeps the hot `scan` path free of an extra room lookup.

> Known limit: within a single very large, very active room, timed-out-but-unconfirmed encounters still accumulate in the Durable Object until the room is cleaned up. If this becomes a problem, add a `purge_at` grace window to `active_encounters` and purge from the `alarm()` handler.
