# API reference — QRMeet

All routes are mounted under `/api/`. Errors always return JSON `{ "error": "..." }`.

## Table of contents

- [Frontend routes](#frontend-routes) — HTML pages served by the worker
- [Rooms](#rooms) — `POST /api/rooms`, `GET /api/rooms/:roomId`
- [Users](#users) — join, profile, QR token, score
- [Scan](#scan) — core game action
- [Treasure](#treasure) — treasure hunt claim
- [Board](#board-public) — public leaderboard & graph
- [Admin](#admin) — auth-protected management
- [WebSocket](#websocket) — real-time events

---

## Frontend routes

HTML pages served by the worker. All paths below return the corresponding HTML file with CSP headers applied.

| Path | File | Description |
|---|---|---|
| `/` | `index.html` | Landing page — create or join a room |
| `/admin` | `admin.html` | Admin console — device-local launcher for the rooms the organiser administers (see [Admin keychain](architecture.md#admin-keychain)). Reached via a hidden long-press on the About logo, the PWA manifest shortcut, or directly by URL. |
| `/r/:roomId` | `index.html` | Auto-joins the room, shows card view |
| `/r/:roomId/scan/:publicId?t=<token>` | `index.html` | QR scan landing — processes scan then redirects to card |
| `/r/:roomId/treasure/:treasureId` | `index.html` | Treasure QR landing — claims the treasure then redirects to card |
| `/r/:roomId/board` | `board.html` | Public leaderboard & graph (no auth) |
| `/r/:roomId/admin` | `admin-room.html` | Admin dashboard for one room (password-protected) |

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
  "score": 6,
  "meetings": 3,
  "treasurePoints": 3,
  "treasuresFound": 1,
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
1. Rejects with `403` if the organizer has paused the game (`scanningEnabled: false`) — no encounter is started or confirmed. The client shows the returned message on the scan page.
2. Verifies the scanner's identity via `privateToken`.
3. Verifies the QR token against KV (the token is **not burned** if the scan would be rejected).
4. Checks whether an open encounter already exists between the pair:
   - **No encounter** → checks the busy guard below, then burns token, creates encounter row, picks two random questions from the room's pool (one per participant), notifies `DurableRoom`, returns `started`. If a simultaneous scan of the same pair already created the row (UNIQUE constraint), the duplicate request returns `started` for the existing encounter instead of erroring.
   - **Open encounter, `notified_at` not set** → session still in progress, returns `409`.
   - **Open encounter, `notified_at` set** → burns token, marks encounter as `counted = 1`, notifies `DurableRoom`, returns `confirmed`.
   - **Counted encounter** → returns `409`.

   **Busy guard** (new-encounter path only): a user may hold only **one active conversation at a time**. Before creating a new encounter, the server rejects with `409` if the scanner *or* the scannee already has an encounter whose timer is still running (`notified_at IS NULL AND counted = 0`) with a third party. The QR token is **not** burned, so the scannee's card stays valid. The error message distinguishes whether it is the scanner or the scannee who is busy. Encounters awaiting confirmation (`notified_at` set, timer elapsed) do **not** count as busy.

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

> `score` everywhere in the API is **unified**: confirmed encounters (1 point each) **plus** treasure points. The `meetings` field, where present, is the encounter-only count.

---

## Treasure

Treasure hunt mode: special static QR codes (`/r/:roomId/treasure/:treasureId`) that anyone can scan once to instantly earn points, with **no conversation started**. The mode is toggled per room (`treasureHuntEnabled`); admins manage the codes via the [Admin](#admin) endpoints below.

### `POST /api/rooms/:roomId/treasures/:treasureId/claim`
Claim a treasure. No body — the `:treasureId` path segment (a 12-char unguessable id) is the capability. The scanner is auto-created beforehand by the client (`POST /users`), so a brand-new visitor can claim immediately.

**Header** `x-private-token: <scanner's privateToken>`

The server:
1. Verifies the scanner's identity via `privateToken`.
2. Rejects with `403` if the organizer has paused the game (`scanningEnabled: false`) — the pause freezes treasure claims too.
3. Rejects with `403` if `treasureHuntEnabled` is off for the room.
4. Rejects with `404`/`403` if the treasure is missing or disabled.
4. Awards `treasure.points ?? room.treasureDefaultPoints`, snapshotted into `treasure_scans`.
5. `UNIQUE(treasure_id, user_id)` guarantees one claim per player; a repeat returns `already_claimed`.

**Response `200` — claimed**
```json
{ "action": "claimed", "points": 3, "label": "Near the coffee machine" }
```

**Response `200` — already claimed**
```json
{ "action": "already_claimed", "label": "Near the coffee machine" }
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
  "scanningEnabled": true,
  "questionsEnabled": true,
  "encounterDurationSeconds": 300,
  "encounterDurationIsDefault": true,
  "maxParticipants": 100,
  "maxParticipantsIsDefault": true,
  "treasureHuntEnabled": false,
  "treasureDefaultPoints": 3,
  "roomTtlDays": 7
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
  "scanningEnabled": true,
  "questionsEnabled": false,
  "encounterDurationSeconds": 120,
  "maxParticipants": 50,
  "treasureHuntEnabled": true,
  "treasureDefaultPoints": 3
}
```

Pass `null` for `encounterDurationSeconds` or `maxParticipants` to reset to the server default. `treasureDefaultPoints` must be an integer ≥ 1 and is the points awarded for any treasure that has no per-QR override.

**Response `200`**
```json
{ "ok": true }
```

---

### `POST /api/admin/rooms/:roomId/renew`
Reset the room's auto-deletion to a fresh full window: `now + ROOM_TTL_DAYS`. `ROOM_TTL_DAYS` (server env, default 7) is therefore both the lifetime and the effective ceiling — renewing never pushes the expiry beyond it, and never shortens an already-longer window. No body.

**Response `200`**
```json
{ "expiresAt": 1234567890, "roomTtlDays": 7 }
```

---

### `DELETE /api/admin/rooms/:roomId`
Permanently delete the room and all its data (encounters, users, questions, treasures). Also wipes the room's Durable Object.

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

### `GET /api/admin/rooms/:roomId/treasures`
List the room's treasures with their scan counts. `effectivePoints` is `points ?? defaultPoints`.

**Response `200`**
```json
{
  "defaultPoints": 3,
  "treasures": [
    { "id": "abc123def456", "label": "Near the coffee machine", "points": null, "effectivePoints": 3, "enabled": 1, "scans": 5, "created_at": 0 },
    { "id": "xyz789abc012", "label": "Rare one", "points": 10, "effectivePoints": 10, "enabled": 0, "scans": 0, "created_at": 0 }
  ]
}
```

---

### `POST /api/admin/rooms/:roomId/treasures`
Create a treasure. `points` omitted or `null` means inherit the room default; a number (integer ≥ 1) sets a per-QR override.

**Body**
```json
{ "label": "Near the coffee machine", "points": null }
```
**Response `201`**
```json
{ "id": "abc123def456", "label": "Near the coffee machine", "points": null, "enabled": 1, "created_at": 0 }
```

---

### `PUT /api/admin/rooms/:roomId/treasures/:tid`
Update a treasure. All fields optional. `points: null` clears the override back to inherit; `enabled` toggles availability.

**Body**
```json
{ "label": "Moved to the lobby", "points": 5, "enabled": true }
```
**Response `200`**
```json
{ "id": "abc123def456", "label": "Moved to the lobby", "points": 5, "enabled": 1 }
```

---

### `DELETE /api/admin/rooms/:roomId/treasures/:tid`
Delete a treasure and its scan records. Points already counted in players' scores were snapshotted, but removing the scan rows lowers those players' scores accordingly.

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
