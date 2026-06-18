# API reference — QRMeet

All routes are mounted under `/api/`. Errors always return JSON `{ "error": "..." }`.

## Table of contents

- [Frontend routes](#frontend-routes) — HTML pages served by the worker
- [Rooms](#rooms) — `POST /api/rooms`, `GET /api/rooms/:roomId`
- [Users](#users) — join, profile, QR token, score
- [Scan](#scan) — core game action
- [Board](#board-public) — public leaderboard & graph
- [Admin](#admin) — auth-protected management
- [WebSocket](#websocket) — real-time events

---

## Frontend routes

HTML pages served by the worker. All paths below return the corresponding HTML file with CSP headers applied.

| Path | File | Description |
|---|---|---|
| `/` | `index.html` | Landing page — create or join a room |
| `/r/:roomId` | `index.html` | Auto-joins the room, shows card view |
| `/r/:roomId/scan/:publicId?t=<token>` | `index.html` | QR scan landing — processes scan then redirects to card |
| `/r/:roomId/board` | `board.html` | Public leaderboard & graph (no auth) |
| `/r/:roomId/admin` | `admin.html` | Admin dashboard (password-protected) |

---

## Rooms

### `POST /api/rooms`
Create a new room. The client sends a SHA-256 hash of the password (never the plaintext); the server stores a second hash of that value. The 20 default conversation questions are seeded into the room's `questions` table at creation time.

**Body**
```json
{ "name": "Team Building 2026", "adminPassword": "<sha256-hash-of-password>" }
```
**Response `201`**
```json
{ "id": "abc123", "name": "Team Building 2026", "expiresAt": 1234567890 }
```
`expiresAt` is `created_at` + the configurable room lifetime (`ROOM_TTL_DAYS` env var, default 7 days).

---

### `GET /api/rooms/:roomId`
Fetch room metadata.

**Response `200`**
```json
{ "id": "abc123", "name": "Team Building 2026", "created_at": 0, "expires_at": 0 }
```

---

## Users

### `POST /api/rooms/:roomId/users`
Join a room. Creates a new anonymous user and returns their credentials.

**Response `201`**
```json
{ "publicId": "abc123def456", "privateToken": "<32-char token>", "displayName": "Alice" }
```

---

### `POST /api/rooms/:roomId/users/:uid/profile`
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

### `POST /api/rooms/:roomId/users/:uid/qr-token`
Issue (or rotate) a single-use QR token for this user. Overwrites any existing token. The token is stored in KV with a 1-hour TTL and is burned on first successful scan.

**Header** `x-private-token: <privateToken>`

**Response `200`**
```json
{ "token": "<opaque token>" }
```

---

### `GET /api/rooms/:roomId/users/:uid/score`
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

## Scan

### `POST /api/rooms/:roomId/scan`
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
   - **No encounter** → burns token, creates encounter row, picks two random questions from the room's pool (one per participant), notifies `DurableRoom`, returns `started`. If a simultaneous scan of the same pair already created the row (UNIQUE constraint), the duplicate request returns `started` for the existing encounter instead of erroring.
   - **Open encounter, `notified_at` not set** → session still in progress, returns `409`.
   - **Open encounter, `notified_at` set** → burns token, marks encounter as `counted = 1`, notifies `DurableRoom`, returns `confirmed`.
   - **Counted encounter** → returns `409`.

**Response `200` — session started**
```json
{
  "action": "started",
  "encounterId": "...",
  "endsAt": 1234567890,
  "serverTime": 1234567890,
  "partner": { "publicId": "...", "displayName": "Bob", "emoji": "😎" }
}
```

**Response `200` — meeting confirmed**
```json
{ "action": "confirmed", "encounterId": "..." }
```

---

## Board (public)

No authentication required.

### `GET /api/rooms/:roomId/board/scores`
Top 10 leaderboard.

**Response `200`**
```json
{
  "scores": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁", "score": 5 }],
  "totalParticipants": 42,
  "roomName": "Team Building 2026",
  "expiresAt": 1234567890
}
```

---

### `GET /api/rooms/:roomId/board/graph`
Full encounter graph (all participants and confirmed edges).

**Response `200`**
```json
{
  "nodes": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁" }],
  "edges": [{ "user_a_id": "...", "user_b_id": "...", "started_at": 0, "counted": 1 }]
}
```

---

## Admin

All admin routes require `x-admin-token: <hash-of-password>` header.

### `GET /api/admin/rooms/:roomId/scores`
Full ranked leaderboard with creation dates and network tags.

**Response `200`**
```json
{
  "scores": [
    { "public_id": "...", "display_name": "Alice", "emoji": "🦁", "created_at": 1716800000, "score": 5, "network_tag": "a1b2c3d4" }
  ],
  "expiresAt": 1234567890
}
```

`network_tag` is the first 8 hex characters of the HMAC of the user's IP, salted per room. Useful for spotting duplicate or bot-created accounts.

---

### `GET /api/admin/rooms/:roomId/graph`
Encounter graph for D3 visualisation.

**Response `200`**
```json
{
  "nodes": [{ "public_id": "...", "display_name": "Alice", "emoji": "🦁" }],
  "edges": [{ "user_a_id": "...", "user_b_id": "...", "started_at": 0, "counted": 1 }]
}
```

---

### `GET /api/admin/rooms/:roomId/settings`
Fetch current room settings.

**Response `200`**
```json
{
  "name": "Team Building 2026",
  "isOpen": true,
  "questionsEnabled": true,
  "encounterDurationSeconds": 300,
  "encounterDurationIsDefault": true,
  "maxParticipants": 100,
  "maxParticipantsIsDefault": true
}
```

---

### `PUT /api/admin/rooms/:roomId/settings`
Update room settings. All fields are optional; only provided fields are updated.

**Body** (all fields optional)
```json
{
  "name": "Team Building 2026",
  "isOpen": true,
  "questionsEnabled": false,
  "encounterDurationSeconds": 120,
  "maxParticipants": 50
}
```

Pass `null` for `encounterDurationSeconds` or `maxParticipants` to reset to the server default.

**Response `200`**
```json
{ "ok": true }
```

---

### `DELETE /api/admin/rooms/:roomId`
Permanently delete the room and all its data (encounters, users, questions). Also wipes the room's Durable Object.

**Response `200`**
```json
{ "ok": true }
```

---

### `DELETE /api/admin/rooms/:roomId/users/:uid`
Remove a user. Their encounters are deleted first to avoid foreign key constraint errors.

**Response `200`**
```json
{ "ok": true }
```

---

### `GET /api/admin/rooms/:roomId/questions`
List all questions for the room, ordered by creation date.

**Response `200`**
```json
{
  "questions": [
    { "id": "abc123def456", "text": "What does a typical day look like in your role?" },
    { "id": "xyz789abc012", "text": "Custom question added by the organiser" }
  ]
}
```

---

### `POST /api/admin/rooms/:roomId/questions`
Add a question to the room's pool.

**Body**
```json
{ "text": "What brought you to this event?" }
```
**Response `201`**
```json
{ "id": "abc123def456", "text": "What brought you to this event?" }
```

---

### `DELETE /api/admin/rooms/:roomId/questions/:qid`
Remove a question from the room's pool.

**Response `200`**
```json
{ "ok": true }
```

---

## WebSocket

### `GET /api/rooms/:roomId/users/:uid/ws`
Upgrade to WebSocket. The private token is passed via the **`Sec-WebSocket-Protocol`** header as the two subprotocol values `qrmeet.token, <privateToken>` (browsers cannot set arbitrary headers on WebSocket connections, but they *can* set subprotocols). This keeps the token out of the URL — and therefore out of access/observability logs. The server echoes back the `qrmeet.token` subprotocol (never the token) on success. Non-browser clients may instead send the `x-private-token` header.

The connection is proxied to the room's `DurableRoom` instance. The user stays connected for the entire duration of their participation — no polling.

- On connect, if the user has an active encounter, the DO immediately sends `session_start`.
- Otherwise it sends `{ "type": "connected" }` and the connection stays open, waiting for events.

**Messages from server**

| `type` | When | Payload |
|---|---|---|
| `connected` | On connect, no active session | — |
| `session_start` | Encounter created (push) or reconnect with active session | `encounterId`, `endsAt`, `serverTime`, `partnerName`, `partnerEmoji`, `question` |
| `session_end` | Timer elapses (Durable Object alarm) | `encounterId`, `message` |
| `session_confirmed` | Meeting confirmed via second scan | `encounterId` |
| `board_update` | Board viewer: triggered on user join or confirmed encounter | — |

`question` in `session_start` is a randomly selected conversation prompt from the room's question pool. Each participant receives a different question. Empty string when questions are disabled for the room (`questionsEnabled: false`).
