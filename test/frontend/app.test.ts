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
  function scanApp(overrides: Record<string, unknown> = {}): any {
    const app = makeApp(overrides)
    app.closeScanner = vi.fn()
    app.ensureUser = vi.fn(async () => {})
    app.doScan = vi.fn(async () => {})
    app.claimTreasure = vi.fn(async () => {})
    app.joinRoom = vi.fn(async () => {})
    return app
  }

  it('routes a same-room scan URL to doScan', async () => {
    const app = scanApp({ roomId: 'room1' })

    await app._handleScannedUrl('https://host/r/room1/scan/p9?t=tok')

    expect(app.page).toBe('scan')
    expect(app.doScan).toHaveBeenCalledWith('p9', 'tok')
  })

  it('routes a treasure URL to claimTreasure', async () => {
    const app = scanApp({ roomId: 'room1' })

    await app._handleScannedUrl('https://host/r/room1/treasure/t5')

    expect(app.claimTreasure).toHaveBeenCalledWith('t5')
  })

  it('routes a bare room URL to joinRoom', async () => {
    const app = scanApp({ roomId: null })

    await app._handleScannedUrl('https://host/r/room9')

    expect(app.joinCode).toBe('room9')
    expect(app.joinRoom).toHaveBeenCalled()
  })

  it('rejects a non-QRMeet URL with a toast', async () => {
    const app = scanApp({ roomId: 'room1' })

    await app._handleScannedUrl('https://host/somewhere/else')

    expect(app.showToast).toHaveBeenCalled()
    expect(app.doScan).not.toHaveBeenCalled()
  })

  it('does not scan a different-room QR when the switch is declined', async () => {
    const app = scanApp({ roomId: 'room1' })
    vi.stubGlobal('confirm', () => false)

    await app._handleScannedUrl('https://host/r/room2/scan/p9?t=tok')

    expect(app.doScan).not.toHaveBeenCalled()
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
