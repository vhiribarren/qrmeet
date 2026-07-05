import { test, expect } from '@playwright/test'
import { appState, createRoom, currentScanUrl, freshScanUrl, joinRoom, newPhone, waitForNotified } from './helpers'

// The session screen must appear for BOTH roles when a scan happens:
// the scannee via the WebSocket push, the scanner via the HTTP response.
test('session screen shows for scanner and scannee', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  // B scans A (navigating A's on-screen QR URL).
  await b.page.goto(await currentScanUrl(a.page))

  // Scannee A: banner appears with no action on A's side (WebSocket session_start).
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toContainText(B.displayName)
  await expect(a.page.getByTestId('session-active')).toContainText(B.displayName)

  // Scanner B: ends on the card with the same banner (HTTP "started").
  await expect(b.page.getByTestId('session-banner')).toBeVisible()
  await expect(b.page.getByTestId('session-banner')).toContainText(A.displayName)
  await expect(b.page.getByTestId('page-card')).toBeVisible()

  await a.ctx.close()
  await b.ctx.close()
})

// After the timer elapses, a confirmation scan confirms the meeting for both:
// the scanner sees the "confirmed" screen, the partner gets +1 over WS.
test('timer expiry then confirmation, both sides', async ({ browser, request }) => {
  const room = await createRoom(request, { durationSeconds: 2 })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // Wait for the server to mark the encounter notified (timer elapsed).
  await waitForNotified(request, A, B.publicId)

  // Confirmation re-scan with a freshly minted token (the first one was burned).
  await b.page.goto(await freshScanUrl(request, A))
  await expect(b.page.getByTestId('scan-confirmed')).toBeVisible()

  // Partner A: banner cleared, score is now 1 (session_confirmed over WS).
  await expect.poll(async () => (await appState(a.page)).score).toBe(1)
  await expect(a.page.getByTestId('session-banner')).toBeHidden()

  await a.ctx.close()
  await b.ctx.close()
})

// A pair that already confirmed cannot start or confirm again.
test('re-scan after confirmation is rejected', async ({ browser, request }) => {
  const room = await createRoom(request, { durationSeconds: 2 })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await waitForNotified(request, A, B.publicId)
  await b.page.goto(await freshScanUrl(request, A))
  await expect(b.page.getByTestId('scan-confirmed')).toBeVisible()

  // Scan the same pair once more → error screen, no auto-return.
  await b.page.goto(await freshScanUrl(request, A))
  await expect(b.page.getByTestId('scan-error')).toBeVisible()

  await a.ctx.close()
  await b.ctx.close()
})

// Busy guard: a user already in a running conversation can't be scanned by a third party.
test('busy guard blocks a third scanner', async ({ browser, request }) => {
  const room = await createRoom(request) // default 5-min timer: stays active
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const c = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)
  await joinRoom(c.page, room.roomId)

  // A and B start a conversation.
  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // C tries to scan A (with a valid fresh token) → busy.
  await c.page.goto(await freshScanUrl(request, A))
  await expect(c.page.getByTestId('scan-error')).toBeVisible()
  await expect(c.page.getByTestId('scan-error')).toContainText(/conversation|progress|busy/i)

  // A's existing session with B is untouched.
  await expect(a.page.getByTestId('session-banner')).toContainText(B.displayName)

  await a.ctx.close()
  await b.ctx.close()
  await c.ctx.close()
})

// Confirming an older meeting must not disturb a *live* conversation the user has
// since started with someone else. A talks to B, the timer elapses, A starts a new
// conversation with C; then B confirms the old A↔B over the wire. A gets the point
// but their on-screen conversation with C must survive (session_confirmed is guarded
// by encounterId — the DO/WS end-to-end version of that reconciliation).
test('confirming an older meeting keeps the active conversation intact', async ({ browser, request }) => {
  // Short timer so A↔B notifies quickly…
  const room = await createRoom(request, { durationSeconds: 2 })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const c = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)
  const C = await joinRoom(c.page, room.roomId)

  // A↔B, then wait for it to elapse (notified, awaiting confirmation).
  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await waitForNotified(request, A, B.publicId)

  // …now lengthen the timer so the *next* encounter (A↔C) stays active while B
  // confirms A↔B. This removes any race between the two encounters expiring.
  const put = await request.put(`/api/admin/rooms/${room.roomId}/settings`, {
    headers: { 'x-admin-token': room.adminToken },
    data: { encounterDurationSeconds: 300 },
  })
  expect(put.ok(), `lengthen timer: ${put.status()}`).toBeTruthy()

  // C scans A → A is now in a live conversation with C.
  await c.page.goto(await freshScanUrl(request, A))
  await expect(a.page.getByTestId('session-banner')).toContainText(C.displayName)

  // B confirms the older A↔B (B isn't busy, so the server allows it).
  await b.page.goto(await freshScanUrl(request, A))
  await expect(b.page.getByTestId('scan-confirmed')).toBeVisible()

  // A received the point (session_confirmed processed)…
  await expect.poll(async () => (await appState(a.page)).score).toBe(1)
  // …but the live conversation with C is untouched — the confirmation for the
  // older encounter must not clear a different, newer active session.
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toContainText(C.displayName)

  await a.ctx.close()
  await b.ctx.close()
  await c.ctx.close()
})

// A QR token is single-use: reusing a burned token to start a NEW encounter fails.
test('burned QR token cannot be reused', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const c = await newPhone(browser)
  await joinRoom(a.page, room.roomId)
  await joinRoom(b.page, room.roomId)
  await joinRoom(c.page, room.roomId)

  // Capture A's on-screen scan URL, then let B burn that exact token.
  const url = await currentScanUrl(a.page)
  await b.page.goto(url)
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // C replays the same (now burned) token → invalid/expired.
  await c.page.goto(url)
  await expect(c.page.getByTestId('scan-error')).toBeVisible()
  await expect(c.page.getByTestId('scan-error')).toContainText(/invalid|expired/i)

  await a.ctx.close()
  await b.ctx.close()
  await c.ctx.close()
})

// When the scannee's token is burned, their card re-issues a fresh one (token_refresh push).
test('scannee QR auto-refreshes after being scanned', async ({ browser, request }) => {
  const room = await createRoom(request)
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  await joinRoom(b.page, room.roomId)

  const tokenBefore = (await appState(a.page)).qrToken
  expect(tokenBefore).toBeTruthy()

  // B scans A using A's currently displayed token.
  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()

  // A's token must change (token_refresh → refreshQrToken).
  await expect.poll(async () => (await appState(a.page)).qrToken).not.toBe(tokenBefore)

  await a.ctx.close()
  await b.ctx.close()
})

// A notified-but-unconfirmed session is restored after a reload, shown in its
// "scan to confirm" state: the DO keeps the encounter active until confirmed and
// re-pushes session_start on reconnect, so the banner comes back with the timer
// elapsed rather than a fresh QR.
test('expired session is restored as a confirm prompt after reload', async ({ browser, request }) => {
  const room = await createRoom(request, { durationSeconds: 2 })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  const A = await joinRoom(a.page, room.roomId)
  const B = await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await waitForNotified(request, A, B.publicId)

  await a.page.reload()
  await expect(a.page.getByTestId('page-card')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toBeVisible()
  await expect(a.page.getByTestId('session-banner')).toContainText(B.displayName)
  await expect(a.page.getByTestId('session-banner')).toContainText(/confirm/i)

  await a.ctx.close()
  await b.ctx.close()
})

// When the organiser pauses the game (scanningEnabled:false), a scan is rejected
// and the client shows the paused message on the error screen.
test('paused game rejects a scan', async ({ browser, request }) => {
  const room = await createRoom(request, { settings: { scanningEnabled: false } })
  const a = await newPhone(browser)
  const b = await newPhone(browser)
  await joinRoom(a.page, room.roomId) // joining is still allowed (gated by isOpen)
  await joinRoom(b.page, room.roomId)

  await b.page.goto(await currentScanUrl(a.page))
  await expect(b.page.getByTestId('scan-error')).toBeVisible()
  await expect(b.page.getByTestId('scan-error')).toContainText(/paused|disabled/i)

  // A is unaffected: no session started.
  await expect(a.page.getByTestId('session-banner')).toBeHidden()

  await a.ctx.close()
  await b.ctx.close()
})
