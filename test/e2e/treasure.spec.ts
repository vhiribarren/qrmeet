import { test, expect } from '@playwright/test'
import { appState, createRoom, createTreasure, joinRoom, newPhone, passConsent, waitWsOnline } from './helpers'

// Treasures created with points:null inherit the room default (TREASURE_DEFAULT_POINTS,
// default 2). We read the awarded amount from the score rather than hard-coding it.
async function expectTreasureScreen(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('scan-treasure')).toBeVisible()
}

// Cold visitor: opening a treasure link with NO prior session auto-joins the
//      room, awards points, and leaves a usable card behind.
test('treasure claim by a brand-new visitor (auto-join)', async ({ browser, request }) => {
  const room = await createRoom(request)
  const treasureId = await createTreasure(request, room)
  const t = await newPhone(browser)

  await t.page.goto(`/r/${room.roomId}/treasure/${treasureId}`)
  await passConsent(t.page) // consent gate: nothing is created until the visitor agrees
  await expectTreasureScreen(t.page)

  // An account was created on the fly and the score reflects the award.
  expect((await appState(t.page)).publicId).toBeTruthy()
  await expect.poll(async () => (await appState(t.page)).score).toBeGreaterThan(0)

  // "Back to my card" lands on a working card (full enterRoom, not a bare switch).
  await t.page.getByRole('button', { name: 'Back to my card' }).click()
  await expect(t.page.getByTestId('page-card')).toBeVisible()
  await waitWsOnline(t.page)

  await t.ctx.close()
})

// Existing player: claiming a treasure reuses the current identity and adds
//      to the running score (no second account, no overwrite).
test('treasure claim by a player already in the room', async ({ browser, request }) => {
  const room = await createRoom(request)
  const treasureId = await createTreasure(request, room)
  const p = await newPhone(browser)
  const before = await joinRoom(p.page, room.roomId)
  expect(before.score).toBe(0)

  await p.page.goto(`/r/${room.roomId}/treasure/${treasureId}`)
  await expectTreasureScreen(p.page)

  expect((await appState(p.page)).publicId).toBe(before.publicId) // same identity, not re-joined
  await expect.poll(async () => (await appState(p.page)).score).toBeGreaterThan(before.score)

  await p.ctx.close()
})

// A treasure can only be claimed once per player; a repeat awards nothing.
test('re-claiming the same treasure is a no-op', async ({ browser, request }) => {
  const room = await createRoom(request)
  const treasureId = await createTreasure(request, room)
  const p = await newPhone(browser)

  await p.page.goto(`/r/${room.roomId}/treasure/${treasureId}`)
  await passConsent(p.page) // first visit: brand-new visitor, gate shown
  await expectTreasureScreen(p.page)
  await expect.poll(async () => (await appState(p.page)).score).toBeGreaterThan(0)
  const earned = (await appState(p.page)).score

  // Second visit → already a member, no gate → "already collected", score unchanged.
  await p.page.goto(`/r/${room.roomId}/treasure/${treasureId}`)
  await expect(p.page.getByTestId('scan-treasure-dup')).toBeVisible()
  await expect.poll(async () => (await appState(p.page)).score).toBe(earned)

  await p.ctx.close()
})

// Cross-room treasure is gated by the same entry consent screen as scans, which
// warns about leaving the current room.
test('cross-room treasure, declined: not claimed, stays in current room', async ({ browser, request }) => {
  const r1 = await createRoom(request)
  const r2 = await createRoom(request)
  const treasureId = await createTreasure(request, r2)
  const p = await newPhone(browser)
  const before = await joinRoom(p.page, r1.roomId)

  await p.page.goto(`/r/${r2.roomId}/treasure/${treasureId}`)
  await expect(p.page.getByTestId('consent-switch-warning')).toBeVisible()
  await p.page.getByTestId('consent-cancel').click()
  await expect(p.page.getByTestId('page-card')).toBeVisible()

  const after = await appState(p.page)
  expect(after.roomId).toBe(r1.roomId)
  expect(after.score).toBe(before.score) // nothing claimed

  await p.ctx.close()
})

test('cross-room treasure, accepted: switches room and claims', async ({ browser, request }) => {
  const r1 = await createRoom(request)
  const r2 = await createRoom(request)
  const treasureId = await createTreasure(request, r2)
  const p = await newPhone(browser)
  const before = await joinRoom(p.page, r1.roomId)

  await p.page.goto(`/r/${r2.roomId}/treasure/${treasureId}`)
  await passConsent(p.page)
  await expectTreasureScreen(p.page)

  const after = await appState(p.page)
  expect(after.roomId).toBe(r2.roomId)
  expect(after.publicId).not.toBe(before.publicId)
  await expect.poll(async () => (await appState(p.page)).score).toBeGreaterThan(0)

  await p.ctx.close()
})
