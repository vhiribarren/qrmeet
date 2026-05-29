# QRMeet

Mobile-first PWA for corporate team building events. Participants scan each other's QR codes to trigger a 5-minute conversation timer, then scan again to confirm the meeting and earn a point.

## How it works

1. An organiser creates a room and shares the room code with attendees.
2. Each participant opens the app on their phone and joins the room. No account or registration needed — the app assigns a private identity stored in `localStorage`.
3. Each participant gets a personal ID card showing their name, emoji, and a QR code.
4. When two people meet, one scans the other's QR code. A 5-minute countdown starts on both phones.
5. After the timer elapses, scanning again confirms the meeting. Both participants earn +1 point.
6. A scoreboard shows each participant their own total and the list of people they've met.
7. The organiser can view a full leaderboard and an interactive encounter graph at `/r/{roomId}/admin`.

### Security model

- Every user has a `publicId` (embedded in QR codes) and a `privateToken` (stored only in `localStorage`, never in QR codes). All mutating API calls require the `privateToken`.
- QR codes embed a single-use opaque token fetched from the server. The token is burned on first scan, preventing QR replay and photo attacks.
- A fresh QR token is automatically issued after each session starts, so the confirmation scan uses a different token than the initial scan.
- Rooms expire after 24 hours. IP-based rate limiting prevents bulk fake-user creation.

## Local development

No Cloudflare account needed. Wrangler simulates D1, KV, and Durable Objects locally.

```bash
npm install
npm run db:migrate   # apply schema to local D1
npm run dev          # Vite dev server on http://localhost:5173
```

> For faster session testing, set `ENCOUNTER_DURATION_SECONDS = "30"` in `wrangler.toml` and restart.

## Deploy to Cloudflare

### 1. Authenticate

```bash
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create qrmeet-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "qrmeet-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← paste here
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create QR_TOKENS
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # ← paste here
```

### 4. Apply the database schema

```bash
npm run db:migrate -- --remote
```

### 5. Deploy

```bash
npm run deploy
```

The Durable Object (`SessionDO`) is registered automatically via the `[[migrations]]` block in `wrangler.toml` — no extra step needed.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Local dev server (Vite + Worker, port 5173) |
| `npm run build` | Production build → `dist/` |
| `npm run deploy` | Build + deploy to Cloudflare |
| `npm run db:migrate` | Apply D1 migrations locally |
| `npm run db:migrate -- --remote` | Apply D1 migrations on production |

## Further reading

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full API reference, data model, and infrastructure overview.

## License

[MIT](LICENSE) — Copyright (c) 2026 Vincent Hiribarren
