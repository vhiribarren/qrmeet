import { afterEach, describe, expect, it, vi } from 'vitest'
import { genPrivateToken, qrmeet } from '../../public/app.js'

// Component-level tests for the Alpine factory. We instantiate the plain object
// returned by qrmeet() and stub its environment (fetch, collaborators, the clock).
// These cover the branches the Playwright e2e suite can't drive deterministically.

function makeApp(overrides: Record<string, unknown> = {}): any {
  const app: any = qrmeet()
  app.$watch = () => {}
  app.me = { publicId: 'me1', privateToken: 'tok', displayName: 'Me', emoji: '😀' }
  app.roomId = 'room1'
  // Stub side-effecting collaborators we don't assert on.
  app.refreshQrToken = vi.fn(async () => {})
  app.loadScore = vi.fn(async () => {})
  app.startSessionTimer = vi.fn()
  app.notify = vi.fn()
  app.showToast = vi.fn()
  Object.assign(app, overrides)
  return app
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('doScan', () => {
  it('treats a 409 "in progress" as success when already in that active session', async () => {
    const now = 1_700_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: now + 100 } })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Session still in progress' }, 409)))

    await app.doScan('other', 'tk')

    // The concurrent mutual scan that lost the insert race is surfaced as success.
    expect(app.scanState).toBe('success')
    expect(app.page).toBe('card')
  })

  it('shows an error for a 409 with no matching active session', async () => {
    const app = makeApp({ session: null })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Session still in progress' }, 409)))

    await app.doScan('other', 'tk')

    expect(app.scanState).toBe('error')
  })

  it('adjusts endsAt for the server/client clock offset on a started session', async () => {
    const now = 1_700_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    const app = makeApp({ session: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          action: 'started',
          encounterId: 'e9',
          endsAt: now + 125, // server clock
          serverTime: now + 5, // server is 5s ahead of the client
          partner: { displayName: 'P', emoji: '🐱' },
          question: 'Q',
        }),
      ),
    )

    await app.doScan('p9', 'tk')

    expect(app.session.endsAt).toBe(now + 120) // (now + 125) shifted back by the 5s offset
    expect(app.session.partnerName).toBe('P')
    expect(app.scanState).toBe('success')
    expect(app.startSessionTimer).toHaveBeenCalled()
  })

  it('rejects a scan with a missing token before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = makeApp()

    await app.doScan('p9', '')

    expect(app.scanState).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('handleWsMessage', () => {
  it('session_start sets the session and adjusts the clock offset', () => {
    const now = 1_700_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    const app = makeApp({ session: null })

    app.handleWsMessage({
      type: 'session_start',
      encounterId: 'e1',
      endsAt: now + 130,
      serverTime: now + 10,
      partnerName: 'P',
      partnerEmoji: '🐱',
      question: 'Q',
    })

    expect(app.session.endsAt).toBe(now + 120)
    expect(app.session.partnerName).toBe('P')
    expect(app.startSessionTimer).toHaveBeenCalled()
    expect(app.loadScore).toHaveBeenCalled()
  })

  it('session_end keeps the session (awaiting confirmation)', () => {
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'session_end' })

    expect(app.session).not.toBeNull()
    expect(app.notify).toHaveBeenCalled()
    expect(app.showToast).toHaveBeenCalled()
  })

  it('session_confirmed clears the matching session', () => {
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'session_confirmed', encounterId: 'e1' })

    expect(app.session).toBeNull()
    expect(app.notify).toHaveBeenCalled()
    expect(app.loadScore).toHaveBeenCalled()
  })

  it('session_confirmed for an older encounter does not clear a newer active session', () => {
    // A confirmation for a pending encounter (e0) must not clobber the live
    // conversation the user has since started with someone else (e1).
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'session_confirmed', encounterId: 'e0' })

    expect(app.session).not.toBeNull()
    expect(app.session.encounterId).toBe('e1')
    expect(app.session.confirmed).toBe(false)
    // The point was still awarded, so the score is refreshed either way.
    expect(app.loadScore).toHaveBeenCalled()
  })

  it('connected clears a stale session left over from a missed push', () => {
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'connected' })

    expect(app.session).toBeNull()
    expect(app.loadScore).toHaveBeenCalled()
  })

  it('connected with no live session is a no-op', () => {
    const app = makeApp({ session: null })

    app.handleWsMessage({ type: 'connected' })

    expect(app.loadScore).not.toHaveBeenCalled()
  })

  it('session_cancelled releases the matching session', () => {
    const app = makeApp({ session: { encounterId: 'e1', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'session_cancelled', encounterId: 'e1', message: 'cancelled' })

    expect(app.session).toBeNull()
    expect(app.showToast).toHaveBeenCalled()
    expect(app.loadScore).toHaveBeenCalled()
  })

  it('session_cancelled for another encounter leaves the current session alone', () => {
    const app = makeApp({ session: { encounterId: 'e2', confirmed: false, endsAt: 1 } })

    app.handleWsMessage({ type: 'session_cancelled', encounterId: 'e1', message: 'cancelled' })

    expect(app.session).not.toBeNull()
    expect(app.loadScore).not.toHaveBeenCalled()
  })

  it('token_refresh re-issues the QR token', () => {
    const app = makeApp()

    app.handleWsMessage({ type: 'token_refresh' })

    expect(app.refreshQrToken).toHaveBeenCalled()
  })
})

describe('_handleScannedUrl', () => {
  // A member of `memberRoom` (its session lives in localStorage). Passing null
  // models a brand-new visitor with no saved session.
  function scanApp(memberRoom: string | null, overrides: Record<string, unknown> = {}): any {
    const app = makeApp(overrides)
    app.closeScanner = vi.fn()
    app.ensureUser = vi.fn(async () => {})
    app.doScan = vi.fn(async () => {})
    app.claimTreasure = vi.fn(async () => {})
    app.joinRoom = vi.fn(async () => {})
    app.loadRoomName = vi.fn(async () => {})
    app.loadSaved = vi.fn(() => (memberRoom ? { me: app.me, roomId: memberRoom } : null))
    return app
  }

  it('routes a same-room scan URL to doScan (already a member, no gate)', async () => {
    const app = scanApp('room1', { roomId: 'room1' })

    await app._handleScannedUrl('https://host/r/room1/scan/p9?t=tok')

    expect(app.page).toBe('scan')
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
  })

  it('routes a same-room treasure URL to claimTreasure (already a member)', async () => {
    const app = scanApp('room1', { roomId: 'room1' })

    await app._handleScannedUrl('https://host/r/room1/treasure/t5')

    expect(app.claimTreasure).toHaveBeenCalledWith('t5')
  })

  it('opens the consent gate for a brand-new deep link instead of auto-joining', async () => {
    const app = scanApp(null, { roomId: null })

    await app._handleScannedUrl('https://host/r/room9')

    expect(app.page).toBe('consent')
    expect(app.pendingEntry).toMatchObject({ type: 'room', roomId: 'room9' })
    expect(app.joinRoom).not.toHaveBeenCalled()
  })

  it('rejects a non-QRMeet URL with a toast', async () => {
    const app = scanApp('room1', { roomId: 'room1' })

    await app._handleScannedUrl('https://host/somewhere/else')

    expect(app.showToast).toHaveBeenCalled()
    expect(app.doScan).not.toHaveBeenCalled()
  })

  it('opens the consent gate (with a prior session) for a different-room scan', async () => {
    const app = scanApp('room1', { roomId: 'room1' })

    await app._handleScannedUrl('https://host/r/room2/scan/p9?t=tok')

    expect(app.page).toBe('consent')
    expect(app.pendingEntry).toMatchObject({ type: 'scan', roomId: 'room2' })
    expect(app.pendingEntry.priorSession).toMatchObject({ roomId: 'room1' })
    expect(app.doScan).not.toHaveBeenCalled()
  })
})

describe('entry consent gate', () => {
  function gateApp(memberRoom: string | null, overrides: Record<string, unknown> = {}): any {
    const app = makeApp(overrides)
    app.ensureUser = vi.fn(async () => {})
    app.doScan = vi.fn(async () => {})
    app.claimTreasure = vi.fn(async () => {})
    app.joinRoom = vi.fn(async () => {})
    app.enterRoom = vi.fn(async () => {})
    app.performSwitchRoom = vi.fn()
    app.loadRoomName = vi.fn(async () => {})
    app.loadSaved = vi.fn(() => (memberRoom ? { me: app.me, roomId: memberRoom } : null))
    return app
  }

  it('requestEntry runs the action directly when already a member', async () => {
    const app = gateApp('room1', { roomId: 'room1' })

    await app.requestEntry({ type: 'scan', roomId: 'room1', scanneePublicId: 'p9', qrToken: 'tok' })

    expect(app.page).toBe('scan')
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
    expect(app.pendingEntry).toBeNull()
  })

  it('requestEntry defers everything behind the gate for a new visitor', async () => {
    const app = gateApp(null, { roomId: null })

    await app.requestEntry({ type: 'treasure', roomId: 'room9', treasureId: 't5' })

    expect(app.page).toBe('consent')
    expect(app.pendingEntry).toMatchObject({ type: 'treasure', roomId: 'room9', priorSession: null })
    // Nothing is created until confirmEntry().
    expect(app.ensureUser).not.toHaveBeenCalled()
    expect(app.claimTreasure).not.toHaveBeenCalled()
  })

  it('confirmEntry creates the account and runs the parked scan', async () => {
    const app = gateApp(null, { roomId: null })
    await app.requestEntry({ type: 'scan', roomId: 'room9', scanneePublicId: 'p9', qrToken: 'tok' })

    await app.confirmEntry()

    expect(app.ensureUser).toHaveBeenCalled()
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
    expect(app.pendingEntry).toBeNull()
  })

  it('confirmEntry resets the old room first when switching', async () => {
    const app = gateApp('room1', { roomId: 'room1' })
    await app.requestEntry({ type: 'room', roomId: 'room2' })

    await app.confirmEntry()

    expect(app.performSwitchRoom).toHaveBeenCalled()
    expect(app.joinRoom).toHaveBeenCalled()
  })

  it('cancelEntry restores the prior room and creates nothing', async () => {
    const app = gateApp('room1', { roomId: 'room1' })
    await app.requestEntry({ type: 'scan', roomId: 'room2', scanneePublicId: 'p9', qrToken: 'tok' })

    app.cancelEntry()

    expect(app.enterRoom).toHaveBeenCalled()
    expect(app.roomId).toBe('room1')
    expect(app.doScan).not.toHaveBeenCalled()
    expect(app.pendingEntry).toBeNull()
  })

  it('cancelEntry returns a first-time visitor to the landing page', async () => {
    const app = gateApp(null, { roomId: null })
    await app.requestEntry({ type: 'room', roomId: 'room9' })

    app.cancelEntry()

    expect(app.page).toBe('landing')
    expect(app.roomId).toBeNull()
    expect(app.joinRoom).not.toHaveBeenCalled()
  })
})

describe('passkeys', () => {
  // Fetch stub routed by URL suffix, so each endpoint answers independently.
  function routedFetch(routes: Record<string, () => Response>) {
    return vi.fn(async (url: string) => {
      for (const [suffix, respond] of Object.entries(routes)) {
        if (String(url).includes(suffix)) return respond()
      }
      return jsonResponse({ error: `no route for ${url}` }, 404)
    })
  }

  function passkeyApp(overrides: Record<string, unknown> = {}): any {
    localStorage.clear()
    const app = makeApp(overrides)
    app.doScan = vi.fn(async () => {})
    app.claimTreasure = vi.fn(async () => {})
    app.joinRoom = vi.fn(async () => {})
    app.enterRoom = vi.fn(async () => {})
    app.performSwitchRoom = vi.fn()
    app.loadRoomName = vi.fn(async () => {})
    app.updateProfile = vi.fn(async () => {})
    app.passkeySupport = true
    return app
  }

  afterEach(() => localStorage.clear())

  it('confirmEntry runs the silent passkey setup when supported', async () => {
    const app = passkeyApp({ roomId: null, me: null })
    app.loadSaved = vi.fn(() => null)
    app.ensureUser = vi.fn(async () => {})
    app.setupPasskey = vi.fn(async () => {})
    await app.requestEntry({ type: 'scan', roomId: 'room9', scanneePublicId: 'p9', qrToken: 'tok' })
    await app.confirmEntry()
    expect(app.ensureUser).toHaveBeenCalled()
    expect(app.setupPasskey).toHaveBeenCalled()
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
  })

  it('confirmEntry bypasses the ceremony when WebAuthn is unsupported', async () => {
    const app = passkeyApp({ roomId: null, me: null, passkeySupport: false })
    app.loadSaved = vi.fn(() => null)
    app.ensureUser = vi.fn(async () => {})
    const ceremony = vi.fn()
    vi.stubGlobal('SimpleWebAuthnBrowser', { startRegistration: ceremony, startAuthentication: ceremony })
    await app.requestEntry({ type: 'treasure', roomId: 'room9', treasureId: 't1' })
    await app.confirmEntry()
    expect(ceremony).not.toHaveBeenCalled()
    expect(app.claimTreasure).toHaveBeenCalled()
  })

  it('confirmEntry forwards the recovery linkToken to ensureUser', async () => {
    const app = passkeyApp({ roomId: null, me: null })
    app.loadSaved = vi.fn(() => null)
    app.ensureUser = vi.fn(async () => {})
    app.setupPasskey = vi.fn(async () => {})
    app.pendingEntry = { type: 'room', roomId: 'room9', priorSession: null }
    app.recovery = { linkToken: 'LT9' }
    await app.confirmEntry()
    expect(app.ensureUser).toHaveBeenCalledWith('LT9')
  })

  it('setupPasskey registers a first passkey and records it', async () => {
    const app = passkeyApp()
    vi.stubGlobal('fetch', routedFetch({
      '/passkey/register-options': () => jsonResponse({ challenge: 'c', rp: { id: 'x' } }),
      '/passkey/register-verify': () => jsonResponse({ ok: true, credentialId: 'cred1', personId: 'P'.repeat(32) }),
    }))
    vi.stubGlobal('SimpleWebAuthnBrowser', {
      startRegistration: vi.fn(async () => ({ id: 'cred1', response: {} })),
    })
    await app.setupPasskey()
    const rec = JSON.parse(localStorage.getItem('qrmeet.passkey')!)
    expect(rec.credentialId).toBe('cred1')
    expect(rec.links.room1).toBe('me1')
    expect(app.passkeyProtected).toBe(true)
  })

  it('setupPasskey remembers a dismissed OS sheet and never re-prompts', async () => {
    const app = passkeyApp()
    vi.stubGlobal('fetch', routedFetch({
      '/passkey/register-options': () => jsonResponse({ challenge: 'c' }),
    }))
    const startRegistration = vi.fn(async () => {
      throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    })
    vi.stubGlobal('SimpleWebAuthnBrowser', { startRegistration })
    await app.setupPasskey()
    expect(JSON.parse(localStorage.getItem('qrmeet.passkey')!).declined).toBe(true)

    await app.setupPasskey() // second join: no ceremony
    expect(startRegistration).toHaveBeenCalledTimes(1)
  })

  it('setupPasskey links an existing credential via get() — never creates a second one', async () => {
    const app = passkeyApp()
    localStorage.setItem('qrmeet.passkey', JSON.stringify({ credentialId: 'cred1', personId: 'p1', links: { other: 'u2' } }))
    const startRegistration = vi.fn()
    const startAuthentication = vi.fn(async () => ({ id: 'cred1', response: {} }))
    vi.stubGlobal('SimpleWebAuthnBrowser', { startRegistration, startAuthentication })
    vi.stubGlobal('fetch', routedFetch({
      '/api/passkey/auth-options': () => jsonResponse({ challenge: 'c' }),
      '/api/passkey/auth-verify': () => jsonResponse({ accounts: [], linkToken: 'LT1', credentialId: 'cred1', personId: 'p1' }),
      '/api/rooms/room1/users': () => jsonResponse({ publicId: 'me1' }, 201),
    }))
    await app.setupPasskey()
    expect(startRegistration).not.toHaveBeenCalled()
    expect(startAuthentication).toHaveBeenCalled()
    const rec = JSON.parse(localStorage.getItem('qrmeet.passkey')!)
    expect(rec.links.room1).toBe('me1')
    expect(app.passkeyProtected).toBe(true)
  })

  it('recoverProfile adopts the matching account and runs the parked entry', async () => {
    const app = passkeyApp({ me: null, roomId: null })
    app._passkeyCeremony = vi.fn(async () => ({ id: 'cred1', response: {} }))
    app.pendingEntry = { type: 'scan', roomId: 'room9', scanneePublicId: 'p9', qrToken: 'tok' }
    vi.stubGlobal('fetch', routedFetch({
      '/api/passkey/auth-verify': () => jsonResponse({
        accounts: [{ roomId: 'room9', roomName: 'R', publicId: 'orig1', privateToken: 'pt1', displayName: 'Orig', emoji: '🦊' }],
        linkToken: 'LT1', credentialId: 'cred1', personId: 'p1',
      }),
    }))
    await app.recoverProfile('room9')
    expect(app.performSwitchRoom).toHaveBeenCalled()   // stale socket/state reset first
    expect(app.me).toMatchObject({ publicId: 'orig1', privateToken: 'pt1' })
    expect(app.roomId).toBe('room9')
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
    expect(app.pendingEntry).toBeNull()
  })

  it('recoverProfile offers the link pane when authenticated without a profile here', async () => {
    const app = passkeyApp({ me: null, roomId: null })
    app._passkeyCeremony = vi.fn(async () => ({ id: 'cred1', response: {} }))
    app.pendingEntry = { type: 'room', roomId: 'room9', priorSession: null }
    vi.stubGlobal('fetch', routedFetch({
      '/api/passkey/auth-verify': () => jsonResponse({
        accounts: [{ roomId: 'elsewhere', publicId: 'u1', privateToken: 'pt', displayName: 'D', emoji: '🦊' }],
        linkToken: 'LT1', credentialId: 'cred1', personId: 'p1',
      }),
    }))
    await app.recoverProfile('room9')
    expect(app.consentStep).toBe('link')
    expect(app.recovery.linkToken).toBe('LT1')
    expect(app.pendingEntry).not.toBeNull()
  })

  it('requestEntry adopts an immediate-mode recovery and skips the consent gate', async () => {
    const app = passkeyApp({ me: null, roomId: null })
    app.loadSaved = vi.fn(() => null)
    app._passkeyCeremony = vi.fn(async () => ({ id: 'cred1', response: {} }))
    vi.stubGlobal('fetch', routedFetch({
      '/api/passkey/auth-verify': () => jsonResponse({
        accounts: [{ roomId: 'room9', publicId: 'orig1', privateToken: 'pt1', displayName: 'Orig', emoji: '🦊' }],
        linkToken: 'LT1', credentialId: 'cred1', personId: 'p1',
      }),
    }))
    await app.requestEntry({ type: 'scan', roomId: 'room9', scanneePublicId: 'p9', qrToken: 'tok' })
    expect(app._passkeyCeremony).toHaveBeenCalledWith({ immediate: true })
    expect(app.page).not.toBe('consent')
    expect(app.me?.publicId).toBe('orig1')
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
  })

  it('requestEntry falls back to the consent gate when the immediate probe rejects', async () => {
    const app = passkeyApp({ me: null, roomId: null })
    app.loadSaved = vi.fn(() => null)
    app._passkeyCeremony = vi.fn(async () => { throw new TypeError('immediate unsupported') })
    await app.requestEntry({ type: 'room', roomId: 'room9' })
    expect(app.page).toBe('consent')
    expect(app.pendingEntry).toMatchObject({ type: 'room', roomId: 'room9' })
  })

  it('ensureUser posts the linkToken and records the local link', async () => {
    const app = passkeyApp({ me: null, roomId: 'room9' })
    app.loadSaved = vi.fn(() => null)
    const fetchMock = routedFetch({
      '/api/rooms/room9/users': () => jsonResponse({ publicId: 'new1', privateToken: 'pt', displayName: 'N' }, 201),
    })
    vi.stubGlobal('fetch', fetchMock)
    app.save = vi.fn()
    await app.ensureUser('LT42')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.linkToken).toBe('LT42')
    expect(JSON.parse(localStorage.getItem('qrmeet.passkey')!).links.room9).toBe('new1')
    expect(app.passkeyProtected).toBe(true)
  })
})

describe('refreshQrToken', () => {
  it('schedules a retry after a transient failure, then renders the fresh token', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app: any = qrmeet()
    app.$watch = () => {}
    app.me = { publicId: 'me1', privateToken: 'tok' }
    app.roomId = 'room1'
    app.showToast = vi.fn()
    app._renderQr = vi.fn()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ token: 'fresh' }, 200))
    vi.stubGlobal('fetch', fetchMock)

    await app.refreshQrToken()
    expect(app.showToast).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The error path schedules a retry 3s later.
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(app.qrToken).toBe('fresh')
    expect(app._renderQr).toHaveBeenCalled()
  })
})

describe('pure helpers', () => {
  it('formatTime formats mm:ss and clamps at zero', () => {
    const app = makeApp()
    expect(app.formatTime(0)).toBe('0:00')
    expect(app.formatTime(-5)).toBe('0:00')
    expect(app.formatTime(9)).toBe('0:09')
    expect(app.formatTime(75)).toBe('1:15')
    expect(app.formatTime(600)).toBe('10:00')
  })

  it('genPrivateToken returns 64 hex chars (256 bits) and is unique', () => {
    const token = genPrivateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(genPrivateToken()).not.toBe(token)
  })

  it('hashPassword returns a base64 SHA-256 digest', async () => {
    const app = makeApp()
    const hash = await app.hashPassword('hunter2')
    // base64 of a 32-byte digest is 44 chars.
    expect(hash).toHaveLength(44)
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})
