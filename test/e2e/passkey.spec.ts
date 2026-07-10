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

// Passkey recovery, driven through the Chromium CDP virtual authenticator
// (ctap2 / transport "internal" / resident keys / user verification, with
// automatic presence simulation so every OS-sheet step auto-approves).
//
// Without WebAuthn.enable, headless Chromium exposes no PublicKeyCredential at
// all — which is also what keeps every other e2e spec free of passkey UI.
//
// A registered credential is EXPORTED from one context's authenticator
// (WebAuthn.getCredentials returns the private key) and INJECTED into a fresh
// context (WebAuthn.addCredential): the fresh context is the "same device,
// different browser container" — exactly the lost-profile bug being fixed.

import { test, expect, type Locator, type Page, type CDPSession } from '@playwright/test'
import { createRoom, newPhone, joinRoom, appState } from './helpers'

interface Authenticator {
  client: CDPSession
  authenticatorId: string
}

async function attachAuthenticator(page: Page): Promise<Authenticator> {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { client, authenticatorId }
}

async function getCredentials(auth: Authenticator) {
  const { credentials } = await auth.client.send('WebAuthn.getCredentials', {
    authenticatorId: auth.authenticatorId,
  })
  return credentials
}

async function injectCredential(auth: Authenticator, credential: any): Promise<void> {
  await auth.client.send('WebAuthn.addCredential', {
    authenticatorId: auth.authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      isResidentCredential: credential.isResidentCredential,
      rpId: credential.rpId,
      privateKey: credential.privateKey,
      userHandle: credential.userHandle,
      signCount: credential.signCount,
    },
  })
}

// Click "I already have a profile" until `target` shows. Right after the
// silent immediate-mode probe rejected, Chrome can transiently refuse the next
// WebAuthn request (NotAllowedError) — which the app deliberately swallows,
// since it is indistinguishable from a user cancelling the OS sheet. A real
// user would simply tap the button again; so does the test.
async function clickRecoverUntil(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByTestId('consent-recover').click()
    try {
      await target.waitFor({ state: 'visible', timeout: 4_000 })
      return
    } catch { /* retry */ }
  }
  await expect(target).toBeVisible()
}

// The invisible reconnect (immediate mode) is best-effort BY DESIGN: Chrome
// only surfaces credentials it knows about, and a CDP-injected credential
// (unlike one created through the browser) is not reliably visible to it. So
// a deep link can legitimately land either straight on the recovered card
// (immediate worked) or on the consent gate (probe rejected — the button is
// the guaranteed path). This helper drives both to the same recovered state.
async function recoverThroughEntry(page: Page): Promise<void> {
  // Both pages exist in the DOM (x-show toggles visibility), so wait on the
  // live Alpine route instead of a DOM locator.
  await page.waitForFunction(
    () => ['card', 'consent'].includes((window as any).Alpine?.$data(document.querySelector('#app'))?.page),
    null,
    { timeout: 15_000 },
  )
  if (await page.getByTestId('page-consent').isVisible()) {
    await clickRecoverUntil(page, page.getByTestId('page-card'))
  }
  await expect(page.getByTestId('page-card')).toBeVisible({ timeout: 15_000 })
}

// Join a room and wait until the silent post-join registration stored the
// credential in the virtual authenticator.
async function joinAndRegister(page: Page, auth: Authenticator, roomId: string) {
  const identity = await joinRoom(page, roomId)
  await expect.poll(async () => (await getCredentials(auth)).length, { timeout: 10_000 }).toBe(1)
  return identity
}

test('joining silently registers a passkey (OS sheet only, no app dialog)', async ({ browser, request }) => {
  const { roomId } = await createRoom(request)
  const phone = await newPhone(browser)
  const auth = await attachAuthenticator(phone.page)

  const identity = await joinAndRegister(phone.page, auth, roomId)

  // The credential is recorded locally for future links/re-registrations.
  const rec = await phone.page.evaluate(() => JSON.parse(localStorage.getItem('qrmeet.passkey') || 'null'))
  expect(rec?.credentialId).toBeTruthy()
  expect(rec?.links?.[roomId]).toBe(identity.publicId)
  await phone.ctx.close()
})

test('a lost context recovers the original profile with the passkey', async ({ browser, request }) => {
  const { roomId } = await createRoom(request)

  // Phone A: join + silent registration, then export the credential.
  const phoneA = await newPhone(browser)
  const authA = await attachAuthenticator(phoneA.page)
  const original = await joinAndRegister(phoneA.page, authA, roomId)
  const [credential] = await getCredentials(authA)
  await phoneA.ctx.close()

  // Phone B: same device, different storage container (blank localStorage).
  const phoneB = await newPhone(browser)
  const authB = await attachAuthenticator(phoneB.page)
  await injectCredential(authB, credential)

  await phoneB.page.goto(`/r/${roomId}`)
  await recoverThroughEntry(phoneB.page)

  const recovered = await appState(phoneB.page)
  expect(recovered.publicId).toBe(original.publicId)
  expect(recovered.roomId).toBe(roomId)
  await phoneB.ctx.close()
})

test('the same passkey gets a fresh linked profile in a new room', async ({ browser, request }) => {
  const { roomId: room1 } = await createRoom(request, { name: 'First' })
  const { roomId: room2 } = await createRoom(request, { name: 'Second' })

  // Register in room1, export the credential.
  const phoneA = await newPhone(browser)
  const authA = await attachAuthenticator(phoneA.page)
  const first = await joinAndRegister(phoneA.page, authA, room1)
  const [credential] = await getCredentials(authA)
  await phoneA.ctx.close()

  // Fresh context, same passkey, deep link into room2 (no profile there).
  // Whether or not the silent immediate probe ran, the consent gate shows
  // (this passkey has no profile in room2). The recover button authenticates
  // and lands on the "no profile here" pane; joining from there links the new
  // profile to the same credential via the linkToken — no create() ceremony.
  const phoneB = await newPhone(browser)
  const authB = await attachAuthenticator(phoneB.page)
  await injectCredential(authB, credential)

  await phoneB.page.goto(`/r/${room2}`)
  await expect(phoneB.page.getByTestId('page-consent')).toBeVisible()
  await clickRecoverUntil(phoneB.page, phoneB.page.getByTestId('consent-link'))
  await phoneB.page.getByTestId('passkey-link-join').click()
  await expect(phoneB.page.getByTestId('page-card')).toBeVisible({ timeout: 15_000 })

  const second = await appState(phoneB.page)
  expect(second.roomId).toBe(room2)
  expect(second.publicId).not.toBe(first.publicId)
  // No second keychain entry was created: still exactly one credential.
  const afterLink = await getCredentials(authB)
  expect(afterLink).toHaveLength(1)
  // The link is recorded locally for both rooms.
  const rec = await phoneB.page.evaluate(() => JSON.parse(localStorage.getItem('qrmeet.passkey') || 'null'))
  expect(rec?.links?.[room2]).toBe(second.publicId)
  await phoneB.ctx.close()

  // Server-side proof: a third blank context recovering from the landing page
  // adopts the MOST RECENT account — the room2 profile. If the link had not
  // been stored server-side, recovery could only surface the room1 account.
  // Inject the credential re-exported AFTER phone B's ceremonies: its
  // signature counter moved, and re-using the stale export would (rightly)
  // trip the server's clone detection. Real synced passkeys sidestep this by
  // always reporting counter 0.
  const phoneC = await newPhone(browser)
  const authC = await attachAuthenticator(phoneC.page)
  await phoneC.page.goto('/')
  await injectCredential(authC, afterLink[0])
  await phoneC.page.getByTestId('landing-recover').click()
  await expect(phoneC.page.getByTestId('page-card')).toBeVisible({ timeout: 15_000 })
  const adopted = await appState(phoneC.page)
  expect(adopted.roomId).toBe(room2)
  expect(adopted.publicId).toBe(second.publicId)
  await phoneC.ctx.close()
})

test('landing recovery restores the profile from the home page', async ({ browser, request }) => {
  const { roomId } = await createRoom(request)

  const phoneA = await newPhone(browser)
  const authA = await attachAuthenticator(phoneA.page)
  const original = await joinAndRegister(phoneA.page, authA, roomId)
  const [credential] = await getCredentials(authA)
  await phoneA.ctx.close()

  const phoneB = await newPhone(browser)
  const authB = await attachAuthenticator(phoneB.page)
  await phoneB.page.goto('/')
  await injectCredential(authB, credential)
  await phoneB.page.getByTestId('landing-recover').click()
  await expect(phoneB.page.getByTestId('page-card')).toBeVisible({ timeout: 15_000 })

  const recovered = await appState(phoneB.page)
  expect(recovered.publicId).toBe(original.publicId)
  await phoneB.ctx.close()
})

test('without WebAuthn no passkey UI appears anywhere', async ({ browser, request }) => {
  const { roomId } = await createRoom(request)
  // No virtual authenticator: headless Chromium has no PublicKeyCredential.
  const phone = await newPhone(browser)
  await phone.page.goto('/')
  await expect(phone.page.getByTestId('landing-recover')).toBeHidden()
  await phone.page.goto(`/r/${roomId}`)
  await expect(phone.page.getByTestId('page-consent')).toBeVisible()
  await expect(phone.page.getByTestId('consent-recover')).toBeHidden()
  await phone.ctx.close()
})
