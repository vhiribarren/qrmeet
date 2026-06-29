import { test, expect } from '@playwright/test'
import { appState, createRoom, currentScanUrl, freshScanUrl, joinRoom, newPhone, waitForNotified, waitWsOnline } from './helpers'

// Entry, identity, persistence and connection-lifecycle behaviour — the pure
// client-side logic in init() / loadSaved() / the WebSocket handlers, which the
// backend Vitest suite does not exercise.

// Manual join from the landing page (the primary non-deep-link entry).
test('join a room via the landing code input', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)

  await a.page.goto('/')
  await a.page.getByRole('button', { name: 'Join a room' }).click()
  await a.page.getByPlaceholder('abc123').fill(room.roomId)
  await a.page.getByRole('button', { name: 'Join', exact: true }).click()

  await expect(a.page.getByTestId('page-card')).toBeVisible()
  await waitWsOnline(a.page)
  expect((await appState(a.page)).roomId).toBe(room.roomId)

  await a.ctx.close()
})

// A saved session resurfaces on the landing page as a "Continue" affordance.
test('resume a saved session from the landing page', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const joined = await joinRoom(a.page, room.roomId)

  // Returning to the root shows the landing page with the resume option.
  await a.page.goto('/')
  await expect(a.page.getByRole('button', { name: 'Continue' })).toBeVisible()
  await a.page.getByRole('button', { name: 'Continue' }).click()

  await expect(a.page.getByTestId('page-card')).toBeVisible()
  const state = await appState(a.page)
  expect(state.roomId).toBe(room.roomId)
  expect(state.publicId).toBe(joined.publicId) // same identity, not a re-join

  await a.ctx.close()
})

// Editing the display name persists to the server AND localStorage (survives reload).
test('profile name edit persists to server and across reload', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const me = await joinRoom(a.page, room.roomId)

  const newName = 'Alice E2E'
  await a.page.getByTestId('name-display').click()
  await a.page.getByTestId('name-input').fill(newName)
  await a.page.getByTestId('name-input').press('Enter')

  // Reflected in the live component state…
  await expect.poll(async () => (await appState(a.page)).displayName).toBe(newName)

  // …persisted on the server…
  const res = await request.get(`/api/rooms/${room.roomId}/users/${me.publicId}/score`, {
    headers: { 'x-private-token': me.privateToken },
  })
  expect((await res.json()).displayName).toBe(newName)

  // …and restored from localStorage after a reload.
  await a.page.reload()
  await expect(a.page.getByTestId('page-card')).toBeVisible()
  expect((await appState(a.page)).displayName).toBe(newName)

  await a.ctx.close()
})

// An active session is restored after a page reload (DO replays session_start on reconnect).
test('active session survives a page reload', async ({ browser, request }) => {
  const room = await createRoom(request) // default long timer: stays active
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // Reload A — the live socket reconnects and the DO re-pushes the active session.
  await a.page.reload()
  await expect(a.page.getByTestId('page-card')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toContainText(B.displayName)
  expect((await appState(a.page)).publicId).toBe(A.publicId)

  await a.ctx.close()
  await b.ctx.close()
})

// A session confirmed while the client was disconnected is cleared on reconnect:
// the DO sends `connected` (no active encounter), and the client drops the stale
// session and re-syncs the score.
test('stale session is cleared on reconnect', async ({ browser, request }) => {
  const room = await createRoom(request, { durationSeconds: 2 })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // Drop A's socket without scheduling a reconnect (detach onclose).
  await a.page.evaluate(() => {
    const app = (window as any).Alpine.$data(document.querySelector('#app'))
    if (app.ws) { app.ws.onclose = null; try { app.ws.close() } catch {} }
    app.ws = null
    app.wsStatus = 'offline'
  })

  // While A is offline, B confirms the meeting.
  await waitForNotified(request, A, B.publicId)
  await b.page.goto(await freshScanUrl(request, A))
  await expect(b.page.getByTestId('scan-confirmed')).toBeVisible()

  // A still shows the stale, unconfirmed session (it missed session_confirmed).
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // On reconnect the DO sends `connected` → A clears the session and re-syncs score.
  await a.page.evaluate(() => (window as any).Alpine.$data(document.querySelector('#app')).connectWs())
  await expect.poll(async () => (await appState(a.page)).score).toBe(1)
  await expect(a.page.getByTestId('session-banner')).toBeHidden()

  await a.ctx.close()
  await b.ctx.close()
})

// Cross-room navigation is gated by a confirmation dialog.
test('cross-room navigation, declined: stays in current room', async ({ browser, request }) => {
  const r1 = await createRoom(request)
  const r2 = await createRoom(request)
  const a = await newPhone(browser)
  await joinRoom(a.page, r1.roomId)

  a.page.on('dialog', (d) => d.dismiss())
  await a.page.goto(`/r/${r2.roomId}`)
  await expect(a.page.getByTestId('page-card')).toBeVisible()
  await expect.poll(async () => (await appState(a.page)).roomId).toBe(r1.roomId)

  await a.ctx.close()
})

test('cross-room navigation, accepted: switches room with a new identity', async ({ browser, request }) => {
  const r1 = await createRoom(request)
  const r2 = await createRoom(request)
  const a = await newPhone(browser)
  const before = await joinRoom(a.page, r1.roomId)

  a.page.on('dialog', (d) => d.accept())
  await a.page.goto(`/r/${r2.roomId}`)
  await expect(a.page.getByTestId('page-card')).toBeVisible()
  await waitWsOnline(a.page)
  const after = await appState(a.page)
  expect(after.roomId).toBe(r2.roomId)
  expect(after.publicId).not.toBe(before.publicId)

  await a.ctx.close()
})

// Connection indicator + reconnect recovery.
// A real network drop can't be simulated against localhost: Chromium's offline
// emulation ignores loopback, and ws.close() leaves the Durable Object socket
// stuck in CLOSING (onclose never fires). So we simulate the lost socket by
// tearing down the connection, then assert connectWs() — the same call the 3s
// reconnect timer makes — restores the live "online" indicator.
test('connection indicator recovers to online after a lost socket', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const joined = await joinRoom(a.page, room.roomId)
  expect(joined.wsStatus).toBe('online')

  await a.page.evaluate(() => {
    const app = (window as any).Alpine.$data(document.querySelector('#app'))
    if (app.ws) { app.ws.onclose = null; try { app.ws.close() } catch {} }
    app.ws = null
    app.wsStatus = 'offline'
  })
  expect((await appState(a.page)).wsStatus).toBe('offline')

  await a.page.evaluate(() => (window as any).Alpine.$data(document.querySelector('#app')).connectWs())
  await expect.poll(async () => (await appState(a.page)).wsStatus, { timeout: 15_000 }).toBe('online')

  await a.ctx.close()
})
