<div align="center">

<img src="public/icon.svg" alt="QRMeet logo" width="110">

# QRMeet

**Scan people, have conversations, earn points.**

A mobile-first networking game for in-person events — no install, no account, no sign-up.

📖 **[Usage guide](docs/usage.md)** · [Architecture](docs/architecture.md) · [API reference](docs/api.md)

</div>

Participants scan each other's QR codes to trigger a conversation timer, then scan again to confirm the meeting and earn a point. An optional treasure hunt awards bonus points from QR codes placed around the venue.

<p align="center">
  <img src="docs/images/card.webp" alt="Personal ID card" width="220">
  <img src="docs/images/session.webp" alt="Conversation timer" width="220">
  <img src="docs/images/score.webp" alt="Score" width="220">
</p>

<p align="center">
  <img src="docs/images/board.webp" alt="Live leaderboard" width="680">
</p>

> 📖 New here? The **[Usage guide](docs/usage.md)** is an illustrated walkthrough with screenshots — for both participants and organisers.

## Technologies

Graphical user interface:

- web app using Alpine, no installation needed
- native technologies without transpiler, JavaScript / HTML / CSS

Backend server:
- use Cloudflare Workers and Durable Objects, with HTTP API and web sockets
- TypeScript

## How it works

1. An organiser creates a room and shares the room code with attendees.
2. Each participant opens the app on their phone and joins the room. No installation, no account or registration needed — the app assigns a private identity stored in `localStorage`.
3. Each participant gets a personal ID card showing their name, emoji, and a QR code.
4. When two people meet, one scans the other's QR code. A 5-minute countdown starts on both phones.
5. After the timer elapses, scanning again confirms the meeting. Both participants earn +1 point.
6. A scoreboard shows each participant their own total and the list of people they've met.
7. The organiser can view a full leaderboard and an interactive encounter graph at `/r/{roomId}/board`.

**Treasure Hunt mode (on by default, can be disabled).** Each room lets the organiser print special QR codes to place around the venue. Anyone scanning one instantly earns points (default 3, configurable per code) — no conversation starts, and each person can collect a given treasure only once. These points add to the same leaderboard. Codes can be added, enabled/disabled, deleted, and re-printed from the admin dashboard's Treasure tab.

### Security model

- Every user has a `publicId` (embedded in QR codes) and a `privateToken` (stored only in `localStorage`, never in QR codes). All mutating API calls require the `privateToken`.
- QR codes embed a single-use opaque token fetched from the server. The token is burned on first scan, preventing QR replay and photo attacks.
- A fresh QR token is automatically issued after each session starts, so the confirmation scan uses a different token than the initial scan.

## Local development

No Cloudflare account needed. Wrangler simulates D1 and Durable Objects locally.

```bash
npm install
npm run db:migrate   # apply schema to local D1
npm run dev          # wrangler dev on http://localhost:8787
```

> For faster session testing, set `ENCOUNTER_DURATION_SECONDS = "30"` in `wrangler.toml` and restart.

## Deploy to Cloudflare

### 0. Create configuration file

First, copy `wrangler.toml.sample` to a local `wrangler.toml`.
It is declared in the `.gitignore` file, so this is local only.

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

### 3. Apply the database schema

```bash
npm run db:migrate -- --remote
```

### 4. Deploy

```bash
npm run deploy
```

The Durable Object (`DurableRoom`) is registered automatically via the `[[migrations]]` block in `wrangler.toml` — no extra step needed.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Local dev server (wrangler, port 8787) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run db:migrate` | Apply D1 migrations locally |
| `npm run db:migrate -- --remote` | Apply D1 migrations on production |
| `npm test` | Run the Vitest suite (unit + Workers integration tests) |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run simulate -- --create-room` | Simulate users and encounters against a running instance (use `--room <id>` to target an existing room) |

## Further reading

- [docs/usage.md](docs/usage.md) — illustrated usage guide for participants and organisers
- [docs/architecture.md](docs/architecture.md) — stack, data model, infrastructure, design decisions
- [docs/api.md](docs/api.md) — full API endpoint reference
- [docs/flows.md](docs/flows.md) — user flows, state machines, sequence diagrams
- [docs/guidelines.md](docs/guidelines.md) — development rules and conventions

## License

[MIT](LICENSE) — Copyright (c) 2026 Vincent Hiribarren
