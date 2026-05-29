# Architecture

## Project structure

```
qrmeet/
├── worker/              ← Cloudflare Worker (backend)
│   ├── index.ts         ← Hono app, route mounting, WS proxy
│   ├── routes/
│   │   ├── rooms.ts    ← Room CRUD
│   │   ├── users.ts    ← Join, profile, QR token, score
│   │   ├── scan.ts     ← Core scan logic
│   │   ├── board.ts    ← Public leaderboard & graph
│   │   └── admin.ts    ← Admin (auth-protected)
│   ├── durable/
│   │   └── DurableRoom.ts
│   └── lib/
│       ├── auth.ts     ← Token hashing, extraction
│       ├── ids.ts      ← nanoid generators
│       └── types.ts    ← Env & model interfaces
├── src/                 ← Frontend JS
│   └── app.js          ← Alpine.js app (SPA)
├── public/              ← Static assets
│   ├── style.css
│   ├── admin.html      ← Admin dashboard (standalone)
│   ├── board.html      ← Public board (standalone)
│   └── manifest.json
├── index.html           ← SPA entry point
├── migrations/
│   └── 0001_init.sql
├── vite.config.ts
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

## Data model

### `rooms`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 6-character random slug (e.g. `abc123`) |
| `name` | TEXT | Display name for the event |
| `admin_token_hash` | TEXT | SHA-256 of the admin password |
| `created_at` | INTEGER | Unix timestamp |
| `expires_at` | INTEGER | Unix timestamp, always `created_at + 86400` (24h) |

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

---

## API reference

All API routes are mounted under `/api/`. Errors always return JSON `{ "error": "..." }`.

### Rooms

#### `POST /api/rooms`
Create a new room. Returns a one-time admin token (never stored in plaintext).

**Body**
```json
{ "name": "Team Building 2026", "adminPassword": "s3cr3t" }
```
**Response `201`**
```json
{ "id": "abc123", "name": "Team Building 2026", "adminToken": "<token>", "expiresAt": 1234567890 }
```

---

#### `GET /api/rooms/:roomId`
Fetch room metadata.

**Response `200`**
```json
{ "id": "abc123", "name": "Team Building 2026", "created_at": 0, "expires_at": 0 }
```

---

### Users

#### `POST /api/rooms/:roomId/users`
Join a room. Creates a new anonymous user and returns their credentials.

**Response `201`**
```json
{ "publicId": "abc123def456", "privateToken": "<32-char token>" }
```
Rate-limited to 10 joins per IP per room per hour (via KV counter).

---

#### `POST /api/rooms/:roomId/users/:uid/profile`
Update display name and/or emoji.

**Header** `x-private-token: <privateToken>`

**Body** (all fields optional)
```json
{ "displayName": "Alice", "emoji": "🦁" }
```
**Response `200`**
```json
{ "ok": true }
```

---

#### `POST /api/rooms/:roomId/users/:uid/qr-token`
Issue (or rotate) a single-use QR token for this user. Overwrites any existing token. The token is stored in KV with a 1-hour TTL and is burned on first successful scan.

**Header** `x-private-token: <privateToken>`

**Response `200`**
```json
{ "token": "<opaque token>" }
```

---

#### `GET /api/rooms/:roomId/users/:uid/score`
Fetch the user's score and encounter history.

**Header** `x-private-token: <privateToken>`

**Response `200`**
```json
{
  "publicId": "...",
  "displayName": "Alice",
  "emoji": "🦁",
  "score": 3,
  "pendingCount": 1,
  "encounters": [
    {
      "id": "...",
      "started_at": 0,
      "closed_at": 0,
      "counted": 1,
      "notified_at": 0,
      "partner_id": "...",
      "partner_name": "Bob",
      "partner_emoji": "😎"
    }
  ]
}
```

---

### Scan

#### `POST /api/rooms/:roomId/scan`
The core game action. Called when a participant scans someone else's QR code.

**Header** `x-private-token: <scanner's privateToken>`

**Body**
```json
{ "scanneePublicId": "abc123def456", "qrToken": "<token from QR URL>" }
```

The client first checks that the scanned QR belongs to the same room. If not, it shows "This person is in a different room" without making any API call.

The server:
1. Verifies the scanner's identity via `privateToken`.
2. Verifies the QR token against KV (the token is **not burned** if the scan would be rejected).
3. Checks whether an open encounter already exists between the pair:
   - **No encounter** → burns token, creates encounter row, notifies `DurableRoom`, returns `started`.
   - **Open encounter, `notified_at` not set** → session still in progress, returns `409`.
   - **Open encounter, `notified_at` set** → burns token, marks encounter as `counted = 1`, notifies `DurableRoom`, returns `confirmed`.
   - **Counted encounter** → returns `409`.

**Response `200` — session started**
```json
{
  "action": "started",
  "encounterId": "...",
  "endsAt": 1234567890,
  "partner": { "publicId": "...", "displayName": "Bob", "emoji": "😎" }
}
```

**Response `200` — meeting confirmed**
```json
{ "action": "confirmed", "encounterId": "..." }
```

---

### Board (public)

No authentication required.

#### `GET /api/rooms/:roomId/board/scores`
Top 10 leaderboard.

**Response `200`**
```json
{
  "scores": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁", "score": 5 }],
  "totalParticipants": 42,
  "roomName": "Team Building 2026"
}
```

---

#### `GET /api/rooms/:roomId/board/graph`
Full encounter graph (all participants and confirmed edges).

**Response `200`**
```json
{
  "nodes": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁" }],
  "edges": [{ "user_a_id": "...", "user_b_id": "...", "started_at": 0, "counted": 1 }]
}
```

---

### Admin

All admin routes require `x-admin-token: <adminToken>` header.

#### `GET /api/admin/rooms/:roomId/scores`
Full ranked leaderboard with creation dates.

**Response `200`**
```json
{
  "scores": [
    { "public_id": "...", "display_name": "Alice", "emoji": "🦁", "created_at": 1716800000, "score": 5 }
  ]
}
```

---

#### `GET /api/admin/rooms/:roomId/graph`
Encounter graph for D3 visualisation.

**Response `200`**
```json
{
  "nodes": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁" }],
  "edges": [{ "user_a_id": "...", "user_b_id": "...", "started_at": 0, "counted": 1 }]
}
```

---

#### `DELETE /api/admin/rooms/:roomId/users/:uid`
Remove a user and all their encounters (cascaded by the DB foreign key).

**Response `200`**
```json
{ "ok": true }
```

---

### WebSocket

#### `GET /api/rooms/:roomId/users/:uid/ws`
Upgrade to WebSocket. Requires `x-private-token` header **or** `?t=<privateToken>` query parameter (browsers cannot set custom headers on WebSocket connections).

The connection is proxied to the room's `DurableRoom` instance. The user stays connected for the entire duration of their participation — no polling.

- On connect, if the user has an active encounter, the DO immediately sends `session_start`.
- Otherwise it sends `{ "type": "connected" }` and the connection stays open, waiting for events.

**Messages from server**

| `type` | When | Payload |
|---|---|---|
| `connected` | On connect, no active session | — |
| `session_start` | Encounter created (push) or reconnect with active session | `encounterId`, `endsAt`, `partnerName`, `partnerEmoji` |
| `session_end` | Timer elapses (Durable Object alarm) | `encounterId`, `message` |
| `session_confirmed` | Meeting confirmed via second scan | `encounterId` |

---

## Frontend routes

| Path | Served as | Description |
|---|---|---|
| `/` | `index.html` | Landing page — create or join a room |
| `/r/:roomId` | `index.html` | Auto-joins the room, shows card view |
| `/r/:roomId/scan/:publicId?t=<token>` | `index.html` | QR scan landing — processes scan then redirects to card |
| `/r/:roomId/board` | `board.html` | Public leaderboard & graph (no auth) |
| `/r/:roomId/admin` | `admin.html` | Admin dashboard (token-protected) |

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
