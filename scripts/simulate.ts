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

/**
 * Simulation script — creates a room, joins N users, and drives the game end-to-end.
 *
 * Encounters run strictly **one at a time** (sequentially): each is started, then the
 * script waits for its timer to expire, then it confirms it, before moving to the next.
 * This mirrors a single pair meeting at a time — there are no parallel rounds.
 *
 * It also exercises the treasure-hunt feature: with --treasures N, it creates N treasure
 * QR codes and has every user claim each one (each awards points once per user).
 *
 * Usage:
 *   npx tsx scripts/simulate.ts [options]
 *
 * You must say which room to target: either join an existing one with --room <id>,
 * or explicitly create a fresh one with --create-room. Requiring an explicit choice
 * guards against accidentally creating a room on a real (e.g. prod) server.
 *
 * Options:
 *   --room        Join this existing room id
 *   --create-room Create a fresh room (mutually exclusive with --room)
 *   --url         Base URL of the QRMeet server  (default: http://localhost:8787)
 *   --users       Number of users to create      (default: 10)
 *   --encounters  Number of encounters to run    (default: all unique pairs)
 *   --treasures   Number of treasure QRs to create and have everyone claim (default: 0)
 *   --name        Room name                       (default: SimulationRoom)
 *   --password    Admin password                  (default: simtest123)
 *
 * Tip: set ENCOUNTER_DURATION_SECONDS low in wrangler.toml (e.g. "5") before simulating —
 * because encounters are sequential, the total runtime is roughly
 * encounters × (duration + buffer).
 */

import { parseArgs } from 'node:util'

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const buf = await (globalThis.crypto as Crypto).subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

const { values: args } = parseArgs({
  options: {
    url:        { type: 'string', default: 'http://localhost:8787' },
    users:      { type: 'string', default: '10' },
    encounters: { type: 'string' },
    treasures:  { type: 'string', default: '0' },
    name:       { type: 'string', default: 'SimulationRoom' },
    password:   { type: 'string', default: 'simtest123' },
    room:          { type: 'string' },
    'create-room': { type: 'boolean', default: false },
    help:          { type: 'boolean', default: false },
  },
  strict: false,
})

const BASE_URL       = args.url!
const USER_COUNT     = Math.max(2, parseInt(args.users!))
const TREASURE_COUNT = Math.max(0, parseInt(args.treasures ?? '0'))
const ROOM_NAME      = args.name!

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiPost<T>(path: string, body: object, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function apiPut<T>(path: string, body: object, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function apiGet<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimUser {
  publicId:     string
  privateToken: string
  displayName:  string
  emoji:        string
}

// ─── Encounter steps (one pair at a time) ───────────────────────────────────────

async function startEncounter(roomId: string, scannee: SimUser, scanner: SimUser) {
  const { token } = await apiPost<{ token: string }>(
    `/api/rooms/${roomId}/users/${scannee.publicId}/qr-token`,
    {},
    { 'x-private-token': scannee.privateToken },
  )
  const start = await apiPost<{ action: string; endsAt: number; serverTime: number }>(
    `/api/rooms/${roomId}/scan`,
    { scanneePublicId: scannee.publicId, qrToken: token },
    { 'x-private-token': scanner.privateToken },
  )
  if (start.action !== 'started') throw new Error(`unexpected action "${start.action}"`)
  return { endsAt: start.endsAt, serverTime: start.serverTime }
}

async function confirmEncounter(roomId: string, scannee: SimUser, scanner: SimUser) {
  const { token } = await apiPost<{ token: string }>(
    `/api/rooms/${roomId}/users/${scannee.publicId}/qr-token`,
    {},
    { 'x-private-token': scannee.privateToken },
  )
  const confirm = await apiPost<{ action: string }>(
    `/api/rooms/${roomId}/scan`,
    { scanneePublicId: scannee.publicId, qrToken: token },
    { 'x-private-token': scanner.privateToken },
  )
  if (confirm.action !== 'confirmed') throw new Error(`unexpected action "${confirm.action}"`)
}

// All unique pairs, shuffled, capped at maxEncounters.
function buildPairs(users: SimUser[], maxEncounters: number): [SimUser, SimUser][] {
  const pairs: [SimUser, SimUser][] = []
  for (let i = 0; i < users.length; i++)
    for (let j = i + 1; j < users.length; j++)
      pairs.push([users[i], users[j]])

  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j], pairs[i]]
  }
  return pairs.slice(0, maxEncounters)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== QRMeet Simulation ===')
  console.log(`URL:       ${BASE_URL}`)
  console.log(`Users:     ${USER_COUNT}`)
  console.log(`Treasures: ${TREASURE_COUNT}`)

  const adminToken = await hashPassword(args.password!)
  const adminHeaders = { 'x-admin-token': adminToken }

  let roomId: string
  if (args.room) {
    roomId = args.room
    console.log(`\nRoom:  ${roomId} (existing)`)
  } else {
    const { id } = await apiPost<{ id: string }>(
      '/api/rooms',
      { name: ROOM_NAME, adminPassword: adminToken },
    )
    roomId = id
    console.log(`\nRoom:  ${roomId} (created)`)
  }

  // Each user supplies its own private token (also the join idempotency key), so a
  // fresh random token per user yields a distinct account. A distinct fake IP is
  // still passed so each user gets its own admin `network_tag`.
  console.log(`\nJoining ${USER_COUNT} users...`)
  const users: SimUser[] = []
  for (let i = 0; i < USER_COUNT; i++) {
    const fakeIp = `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`
    const privateToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
    try {
      const u = await apiPost<{ publicId: string; privateToken: string }>(
        `/api/rooms/${roomId}/users`,
        { privateToken },
        { 'cf-connecting-ip': fakeIp },
      )
      const profile = await apiGet<{ displayName: string; emoji: string }>(
        `/api/rooms/${roomId}/users/${u.publicId}/score`,
        { 'x-private-token': u.privateToken },
      )
      users.push({ publicId: u.publicId, privateToken: u.privateToken, displayName: profile.displayName, emoji: profile.emoji })
      process.stdout.write('.')
    } catch (e) {
      console.error(`\nFailed to join user ${i + 1}: ${e}`)
    }
  }
  console.log(`\nJoined ${users.length} users`)

  if (users.length < 2) {
    console.error('Need at least 2 users to simulate encounters.')
    process.exit(1)
  }

  // ── Treasure hunt ──
  if (TREASURE_COUNT > 0) {
    console.log(`\nSetting up ${TREASURE_COUNT} treasure(s)...`)
    try {
      await apiPut(`/api/admin/rooms/${roomId}/settings`, { treasureHuntEnabled: true }, adminHeaders)
      const treasureIds: string[] = []
      for (let i = 0; i < TREASURE_COUNT; i++) {
        const t = await apiPost<{ id: string }>(
          `/api/admin/rooms/${roomId}/treasures`,
          { label: `Treasure ${i + 1}` },
          adminHeaders,
        )
        treasureIds.push(t.id)
      }

      console.log('Every user claims every treasure...')
      let claimed = 0
      for (const user of users) {
        for (const tid of treasureIds) {
          const r = await apiPost<{ action: string }>(
            `/api/rooms/${roomId}/treasures/${tid}/claim`,
            {},
            { 'x-private-token': user.privateToken },
          )
          if (r.action === 'claimed') claimed++
        }
      }
      console.log(`Treasures claimed: ${claimed} (${TREASURE_COUNT} × ${users.length} users)`)
    } catch (e) {
      console.error(`Treasure setup failed (need the room's admin password via --password): ${e}`)
    }
  }

  // ── Encounters (sequential: one pair at a time) ──
  const maxPairs      = (users.length * (users.length - 1)) / 2
  const maxEncounters = args.encounters ? parseInt(args.encounters) : maxPairs
  const pairs         = buildPairs(users, maxEncounters)

  console.log(`\nSimulating ${pairs.length} encounter(s), one at a time...\n`)

  let totalOk = 0
  let totalFail = 0

  for (let i = 0; i < pairs.length; i++) {
    const [scannee, scanner] = pairs[i]
    const label = `[${i + 1}/${pairs.length}]`
    try {
      const { endsAt, serverTime } = await startEncounter(roomId, scannee, scanner)
      console.log(`${label} started   ${scannee.emoji} ${scannee.displayName} ↔ ${scanner.emoji} ${scanner.displayName}`)

      const waitSec = Math.max(1, endsAt - serverTime) + 2 // +2s for the Durable Object alarm
      await sleep(waitSec * 1000)

      await confirmEncounter(roomId, scannee, scanner)
      console.log(`${label} confirmed`)
      totalOk++
    } catch (e) {
      console.error(`${label} failed: ${e}`)
      totalFail++
    }
  }

  // ── Leaderboard ──
  console.log('\n=== Leaderboard ===')
  const board = await apiGet<{
    scores: { display_name: string; emoji: string; score: number; meetings?: number; treasure_points?: number }[]
    totalParticipants: number
  }>(`/api/rooms/${roomId}/board/scores`)

  if (board.scores.length === 0) {
    console.log('  (no scores yet)')
  } else {
    board.scores.forEach((s, i) => {
      const breakdown = TREASURE_COUNT > 0
        ? `  (${s.meetings ?? 0} met, ${s.treasure_points ?? 0} treasure)`
        : ''
      console.log(`  ${i + 1}. ${s.emoji} ${s.display_name.padEnd(28)} ${s.score} pt${s.score !== 1 ? 's' : ''}${breakdown}`)
    })
  }

  console.log(`\n  Total participants : ${board.totalParticipants}`)
  console.log(`  Encounters OK/total: ${totalOk} / ${totalOk + totalFail}`)
  console.log(`\n  Board : ${BASE_URL}/r/${roomId}/board`)
  console.log(`  Admin : ${BASE_URL}/r/${roomId}/admin`)
}

const HELP = `
QRMeet simulation script
Populates a room with fake users, drives encounters sequentially, and optionally
runs a treasure hunt.

Usage:
  npx tsx scripts/simulate.ts [options]
  npm run simulate -- [options]

You must pick a target room: pass --room <id> to join an existing one, or
--create-room to create a fresh one. Without either, this help is printed and
nothing runs (guards against creating a room on a real/prod server by accident).

Options:
  --room <id>          Join this existing room
  --create-room        Create a fresh room (mutually exclusive with --room)
  --url <url>           Base URL of the QRMeet server
                          default: http://localhost:8787
  --name <name>         Room name (used when creating a new room)
                          default: SimulationRoom
  --password <pw>       Admin password (room creation + admin calls)
                          default: simtest123
  --users <n>           Number of users to create and join
                          default: 10
  --encounters <n>      Number of encounters to simulate
                          default: all unique pairs (users*(users-1)/2)
  --treasures <n>       Create n treasure QR codes and have every user claim them
                          default: 0 (treasure hunt disabled)
  --help                Show this help message

Examples:
  # Create a room, join 10 users, run all encounters one at a time
  npm run simulate -- --create-room

  # Smaller, faster run with a treasure hunt
  npm run simulate -- --create-room --users 5 --encounters 4 --treasures 3

  # Point at an existing room (pass its admin password for treasures)
  npm run simulate -- --room abc123 --password hunter2 --treasures 2

Notes:
  - Encounters are sequential: each is started, the script waits for its timer to
    expire, then confirms it, before the next one. There are no parallel rounds.
  - Total runtime ≈ encounters × (ENCOUNTER_DURATION_SECONDS + 2s). Set a low
    duration in wrangler.toml when simulating many encounters.
  - Distinct fake IPs are sent per user to bypass the per-IP join rate limit in
    local dev (Wrangler sets cf-connecting-ip to 127.0.0.1 for all requests).
`

if (args.help) {
  console.log(HELP)
} else if (args.room && args['create-room']) {
  console.error('Pass either --room <id> or --create-room, not both.')
  process.exit(1)
} else if (!args.room && !args['create-room']) {
  console.log(HELP)
  console.log('Nothing was run: pass --room <id> to join a room, or --create-room to create one.\n')
} else {
  main().catch(err => console.error('\nFatal:', err))
}
