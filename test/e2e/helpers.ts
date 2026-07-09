import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8787'

const DEFAULT_PASSWORD = 'pw1234'

// The admin credential is the *client-side* hash of the password: base64(SHA-256(pw)).
// It is sent as `adminPassword` at room creation and as `x-admin-token` on every
// admin call (the server hashes it a second time before comparing). See
// docs/architecture.md › "Client-side password hashing (double-hash)".
export function adminHash(password = DEFAULT_PASSWORD): string {
  return createHash('sha256').update(password).digest('base64')
}

export interface RoomHandle {
  roomId: string
  adminToken: string
}

// Create a room via the API and (optionally) tweak its settings: shorten the
// encounter timer so the confirmation flow can be tested without waiting the
// default 5 minutes, and/or apply any other room setting (e.g. scanningEnabled).
export async function createRoom(
  request: APIRequestContext,
  opts: { name?: string; password?: string; durationSeconds?: number; settings?: Record<string, unknown> } = {},
): Promise<RoomHandle> {
  const { name = 'E2E', password = DEFAULT_PASSWORD, durationSeconds, settings } = opts
  const adminToken = adminHash(password)
  const res = await request.post('/api/rooms', { data: { name, adminPassword: adminToken } })
  expect(res.ok(), `create room: ${res.status()}`).toBeTruthy()
  const { id } = await res.json()

  const body = {
    ...(durationSeconds !== undefined ? { encounterDurationSeconds: durationSeconds } : {}),
    ...(settings ?? {}),
  }
  if (Object.keys(body).length > 0) {
    const put = await request.put(`/api/admin/rooms/${id}/settings`, {
      headers: { 'x-admin-token': adminToken },
      data: body,
    })
    expect(put.ok(), `set settings: ${put.status()}`).toBeTruthy()
  }
  return { roomId: id, adminToken }
}

export async function createTreasure(
  request: APIRequestContext,
  room: RoomHandle,
  opts: { label?: string; points?: number | null } = {},
): Promise<string> {
  const { label = 'Coffee machine', points = null } = opts
  const res = await request.post(`/api/admin/rooms/${room.roomId}/treasures`, {
    headers: { 'x-admin-token': room.adminToken },
    data: { label, points },
  })
  expect(res.ok(), `create treasure: ${res.status()}`).toBeTruthy()
  return (await res.json()).id
}

export interface Phone {
  ctx: BrowserContext
  page: Page
}

// A fresh browser context = a fresh "phone" with its own localStorage, hence a
// distinct game identity.
export async function newPhone(browser: Browser): Promise<Phone> {
  const ctx = await browser.newContext({ baseURL: BASE_URL })
  const page = await ctx.newPage()
  return { ctx, page }
}

export interface Identity {
  publicId: string
  privateToken: string
  displayName: string
  emoji: string
  qrToken: string | null
  roomId: string | null
  score: number
  wsStatus: string
}

// Read the live Alpine component state. Coupling to internals is acceptable in a
// test and far simpler than scraping the DOM (qrToken isn't in localStorage).
export async function appState(page: Page): Promise<Identity> {
  return page.evaluate(() => {
    const a = (window as any).Alpine.$data(document.querySelector('#app'))
    return {
      publicId: a.me?.publicId,
      privateToken: a.me?.privateToken,
      displayName: a.me?.displayName,
      emoji: a.me?.emoji,
      qrToken: a.qrToken,
      roomId: a.roomId,
      score: a.scoreData?.score ?? 0,
      wsStatus: a.wsStatus,
    }
  })
}

// Pass the entry consent gate shown before any deep-link auto-join (scan /
// treasure / room link for a new or switching visitor). Clicking "Join &
// continue" is what actually creates the account.
export async function passConsent(page: Page): Promise<void> {
  await page.getByTestId('consent-join').click()
}

// Join a room through a real navigation, clear the consent gate, wait until the
// card is ready (QR rendered) and the live socket is up, then return the identity.
export async function joinRoom(page: Page, roomId: string): Promise<Identity> {
  await page.goto(`/r/${roomId}`)
  await passConsent(page)
  await expect(page.getByTestId('page-card')).toBeVisible()
  await page.waitForFunction(() => {
    const a = (window as any).Alpine?.$data(document.querySelector('#app'))
    return a && a.me && a.qrReady
  })
  await waitWsOnline(page)
  return appState(page)
}

export async function waitWsOnline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).Alpine?.$data(document.querySelector('#app'))?.wsStatus === 'online',
    null,
    { timeout: 15_000 },
  )
}

// The scan URL built from the token CURRENTLY displayed on `page`'s card —
// i.e. the real on-screen QR. Capture it *before* it gets burned by a scan.
export async function currentScanUrl(page: Page): Promise<string> {
  const s = await appState(page)
  return `/r/${s.roomId}/scan/${s.publicId}?t=${s.qrToken}`
}

// A guaranteed-valid scan URL minted on demand via the API. Use for the
// confirmation re-scan, where the previous token was already burned.
export async function freshScanUrl(request: APIRequestContext, id: Identity): Promise<string> {
  const res = await request.post(`/api/rooms/${id.roomId}/users/${id.publicId}/qr-token`, {
    headers: { 'x-private-token': id.privateToken },
  })
  expect(res.ok(), `qr-token: ${res.status()}`).toBeTruthy()
  const { token } = await res.json()
  return `/r/${id.roomId}/scan/${id.publicId}?t=${token}`
}

// Poll the server until the encounter with `partnerId` has been notified
// (timer elapsed, notified_at set) — the authoritative "ready to confirm"
// signal, independent of the client-side countdown.
export async function waitForNotified(
  request: APIRequestContext,
  id: Identity,
  partnerId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/rooms/${id.roomId}/users/${id.publicId}/score`, {
          headers: { 'x-private-token': id.privateToken },
        })
        const data = await res.json()
        const enc = (data.encounters ?? []).find((e: any) => e.partner_id === partnerId)
        return enc?.notified_at ?? 0
      },
      { timeout: 15_000, intervals: [300] },
    )
    .toBeGreaterThan(0)
}
