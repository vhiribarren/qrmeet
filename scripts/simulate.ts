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
 * Simulation script — creates a room, joins N users, and drives encounters end-to-end.
 *
 * Encounters run in parallel "rounds" (round-robin schedule) so that no user appears
 * twice in the same round, avoiding QR-token conflicts.
 *
 * Usage:
 *   npx tsx scripts/simulate.ts [options]
 *
 * Options:
 *   --url         Base URL of the QRMeet server  (default: http://localhost:8787)
 *   --users       Number of users to create      (default: 10)
 *   --encounters  Number of encounters to run    (default: all unique pairs)
 *   --name        Room name                      (default: SimulationRoom)
 */

import { parseArgs } from 'node:util'

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const buf  = await (globalThis.crypto as Crypto).subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

const { values: args } = parseArgs({
  options: {
    url:        { type: 'string', default: 'http://localhost:8787' },
    users:      { type: 'string', default: '10' },
    encounters: { type: 'string' },
    name:       { type: 'string', default: 'SimulationRoom' },
    room:       { type: 'string' },
    help:       { type: 'boolean', default: false },
  },
  strict: false,
})

const BASE_URL   = args.url!
const USER_COUNT = Math.max(2, parseInt(args.users!))
const ROOM_NAME  = args.name!

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

interface StartResult {
  scannee:    SimUser
  scanner:    SimUser
  endsAt:     number
  serverTime: number
  label:      string
}

// ─── Round-robin scheduling ───────────────────────────────────────────────────
// Groups pairs so no user appears twice in the same round, preventing QR-token races.

function buildRounds(users: SimUser[], maxEncounters: number): SimUser[][][] {
  const allPairs: SimUser[][] = []
  for (let i = 0; i < users.length; i++)
    for (let j = i + 1; j < users.length; j++)
      allPairs.push([users[i], users[j]])

  for (let i = allPairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPairs[i], allPairs[j]] = [allPairs[j], allPairs[i]]
  }

  const rounds: SimUser[][][] = []
  const remaining = allPairs.slice(0, maxEncounters)

  while (remaining.length > 0) {
    const round: SimUser[][] = []
    const busy  = new Set<string>()
    const carry: SimUser[][] = []

    for (const pair of remaining) {
      if (!busy.has(pair[0].publicId) && !busy.has(pair[1].publicId)) {
        round.push(pair)
        busy.add(pair[0].publicId)
        busy.add(pair[1].publicId)
      } else {
        carry.push(pair)
      }
    }
    rounds.push(round)
    remaining.splice(0, remaining.length, ...carry)
  }
  return rounds
}

// ─── Encounter steps ──────────────────────────────────────────────────────────

async function startEncounter(roomId: string, scannee: SimUser, scanner: SimUser, label: string): Promise<StartResult> {
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
  console.log(`  ${label} started   ${scannee.emoji} ${scannee.displayName} ↔ ${scanner.emoji} ${scanner.displayName}`)
  return { scannee, scanner, endsAt: start.endsAt, serverTime: start.serverTime, label }
}

async function confirmEncounter(roomId: string, r: StartResult): Promise<void> {
  const { token } = await apiPost<{ token: string }>(
    `/api/rooms/${roomId}/users/${r.scannee.publicId}/qr-token`,
    {},
    { 'x-private-token': r.scannee.privateToken },
  )
  const confirm = await apiPost<{ action: string }>(
    `/api/rooms/${roomId}/scan`,
    { scanneePublicId: r.scannee.publicId, qrToken: token },
    { 'x-private-token': r.scanner.privateToken },
  )
  if (confirm.action !== 'confirmed') throw new Error(`unexpected action "${confirm.action}"`)
  console.log(`  ${r.label} confirmed ${r.scannee.emoji} ${r.scannee.displayName} ↔ ${r.scanner.emoji} ${r.scanner.displayName}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== QRMeet Simulation ===')
  console.log(`URL:   ${BASE_URL}`)
  console.log(`Users: ${USER_COUNT}`)

  let roomId: string
  if (args.room) {
    roomId = args.room
    console.log(`\nRoom:  ${roomId} (existing)`)
  } else {
    const adminPasswordHash = await hashPassword('simtest123')
    const { id } = await apiPost<{ id: string }>(
      '/api/rooms',
      { name: ROOM_NAME, adminPassword: adminPasswordHash },
    )
    roomId = id
    console.log(`\nRoom:  ${roomId} (created)`)
  }

  // Join users with distinct fake IPs to bypass the per-IP rate limit in local dev
  console.log(`\nJoining ${USER_COUNT} users...`)
  const users: SimUser[] = []
  for (let i = 0; i < USER_COUNT; i++) {
    const fakeIp = `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`
    try {
      const u = await apiPost<{ publicId: string; privateToken: string }>(
        `/api/rooms/${roomId}/users`,
        {},
        { 'x-forwarded-for': fakeIp },
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

  const maxPairs      = (users.length * (users.length - 1)) / 2
  const maxEncounters = args.encounters ? parseInt(args.encounters) : maxPairs
  const rounds        = buildRounds(users, maxEncounters)
  const totalPlanned  = rounds.reduce((s, r) => s + r.length, 0)

  console.log(`\nSimulating ${totalPlanned} encounter(s) across ${rounds.length} round(s)`)
  console.log('(within a round all encounters run in parallel)\n')

  let totalOk   = 0
  let totalFail = 0

  for (let ri = 0; ri < rounds.length; ri++) {
    const round = rounds[ri]
    console.log(`Round ${ri + 1}/${rounds.length} — ${round.length} encounter(s)`)

    const startResults = await Promise.allSettled(
      round.map((pair, pi) => startEncounter(roomId, pair[0], pair[1], `[R${ri + 1}/E${pi + 1}]`))
    )

    const started = startResults
      .filter((r): r is PromiseFulfilledResult<StartResult> => r.status === 'fulfilled')
      .map(r => r.value)

    startResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .forEach((r, i) => console.error(`  [R${ri + 1}/E${i + 1}] start failed: ${r.reason}`))

    if (started.length === 0) {
      totalFail += round.length
      continue
    }

    // Wait until the last timer in this round expires (+3s buffer for Durable Object alarm)
    const waitSec = Math.max(...started.map(r => r.endsAt - r.serverTime)) + 3
    console.log(`  Waiting ${waitSec}s for encounter timer(s) to expire...`)
    await sleep(waitSec * 1000)

    const confirmResults = await Promise.allSettled(started.map(r => confirmEncounter(roomId, r)))
    const roundOk   = confirmResults.filter(r => r.status === 'fulfilled').length
    const roundFail = confirmResults.length - roundOk + (round.length - started.length)

    confirmResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .forEach((r, i) => console.error(`  [R${ri + 1}/E${i + 1}] confirm failed: ${r.reason}`))

    totalOk   += roundOk
    totalFail += roundFail
  }

  console.log('\n=== Leaderboard ===')
  const board = await apiGet<{
    scores:            { displayName: string; emoji: string; score: number }[]
    totalParticipants: number
  }>(`/api/rooms/${roomId}/board/scores`)

  if (board.scores.length === 0) {
    console.log('  (no scores yet)')
  } else {
    board.scores.forEach((s, i) =>
      console.log(`  ${i + 1}. ${s.emoji} ${s.displayName.padEnd(28)} ${s.score} pt${s.score !== 1 ? 's' : ''}`)
    )
  }

  console.log(`\n  Total participants : ${board.totalParticipants}`)
  console.log(`  Encounters OK/total: ${totalOk} / ${totalOk + totalFail}`)
  console.log(`\n  Board : ${BASE_URL}/r/${roomId}/board`)
  console.log(`  Admin : ${BASE_URL}/r/${roomId}/admin`)
}

if (args.help) {
  console.log(`
QRMeet simulation script
Populates a room with fake users and drives encounters end-to-end.

Usage:
  npx tsx scripts/simulate.ts [options]
  npm run simulate -- [options]

Options:
  --url <url>           Base URL of the QRMeet server
                          default: http://localhost:8787
  --name <name>         Room name (used when creating a new room)
                          default: SimulationRoom
  --room <id>           Use an existing room instead of creating one
  --users <n>           Number of users to create and join
                          default: 10
  --encounters <n>      Number of encounters to simulate
                          default: all unique pairs (users*(users-1)/2)
  --help                Show this help message

Examples:
  # Create a room, join 10 users, simulate all possible encounters
  npm run simulate

  # Use an existing room, add 6 users, run 5 encounters
  npm run simulate -- --room abc123 --users 6 --encounters 5

  # Point at a remote server
  npm run simulate -- --url https://qrmeet.example.com --name "Demo Day" --users 20

Notes:
  - Encounters run in parallel rounds: within a round no user appears twice,
    avoiding QR-token conflicts.
  - Each round waits for the encounter timer to expire before confirming.
    With the default 30 s timer, 10 users (9 rounds max) takes ~5 minutes.
  - Distinct fake IPs are sent per user to bypass the per-IP join rate limit
    in local dev (Wrangler sets cf-connecting-ip to 127.0.0.1 for all requests).
`)
} else {
  main().catch(err => console.error('\nFatal:', err))
}

