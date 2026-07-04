import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, scan, getScore, issueQrToken, admin, fetchWorker, env, BASE } from '../helpers'

// Simulate the encounter timer elapsing. This is exactly the UPDATE the DurableRoom
// alarm runs when it fires; doing it directly keeps the confirm path deterministic
// without depending on real-time alarm scheduling.
async function markTimerElapsed(roomId: string) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    'UPDATE encounters SET notified_at = ? WHERE room_id = ? AND notified_at IS NULL'
  ).bind(now, roomId).run()
}

describe('scan / encounter lifecycle', () => {
  it('starts an encounter on first scan', async () => {
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    const { res, data } = await scan(roomId, a, b)
    expect(res.status).toBe(200)
    expect(data.action).toBe('started')
    expect(data.partner.publicId).toBe(b.publicId)
    // The scanner's own conversation question rides on the HTTP response (not only
    // the WebSocket push), so a scanner with no live socket still gets one.
    expect(typeof data.question).toBe('string')
    expect(data.question.length).toBeGreaterThan(0)
  })

  it('rejects scanning yourself', async () => {
    const { roomId } = await createRoom()
    const a = await joinUser(roomId)
    const { res } = await scan(roomId, a, a)
    expect(res.status).toBe(400)
  })

  it('rejects a second scan while the encounter is still running', async () => {
    const { roomId, adminToken } = await createRoom()
    // The test env's default duration is 0 (encounters expire instantly, see
    // vitest.config.ts), so "still running" needs a real per-room timer —
    // otherwise the missed-alarm self-heal legitimately confirms instead.
    await admin(roomId, adminToken).put('/settings', { encounterDurationSeconds: 300 })
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b)
    const { res, data } = await scan(roomId, a, b)
    expect(res.status).toBe(409)
    expect(data.error).toMatch(/progress/i)
  })

  it('confirms after the timer and awards one point to each', async () => {
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b)
    await markTimerElapsed(roomId)

    const { res, data } = await scan(roomId, a, b)
    expect(res.status).toBe(200)
    expect(data.action).toBe('confirmed')

    const sa = await getScore(roomId, a)
    const sb = await getScore(roomId, b)
    expect(sa.data.score).toBe(1)
    expect(sa.data.meetings).toBe(1)
    expect(sb.data.score).toBe(1)
  })

  it('rejects scanning a pair that already completed a session', async () => {
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b)
    await markTimerElapsed(roomId)
    await scan(roomId, a, b) // confirm
    const { res, data } = await scan(roomId, a, b)
    expect(res.status).toBe(409)
    expect(data.error).toMatch(/already completed/i)
  })

  it('busy guard: blocks a new encounter while already in one', async () => {
    const { roomId } = await createRoom()
    const [a, b, c] = [await joinUser(roomId), await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b) // a and b now busy
    const { res, data } = await scan(roomId, a, c)
    expect(res.status).toBe(409)
    expect(data.error).toMatch(/already in a conversation/i)
  })

  it('rejects an invalid QR token', async () => {
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-private-token': a.privateToken },
      body: JSON.stringify({ scanneePublicId: b.publicId, qrToken: 'bogus' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects scanning without auth', async () => {
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    const token = await issueQrToken(roomId, b)
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanneePublicId: b.publicId, qrToken: token }),
    })
    expect(res.status).toBe(401)
  })

  it('blocks scanning when the game is paused', async () => {
    const { roomId, adminToken } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await admin(roomId, adminToken).put('/settings', { scanningEnabled: false })
    const { res } = await scan(roomId, a, b)
    expect(res.status).toBe(403)
  })

  it('confirms after the timer even if the scannee token was never refreshed', async () => {
    // Regression for the "legitimate confirmation scan fails" bug: the server
    // burns the scannee's token at session start, and the client is supposed to
    // re-issue it. If that refresh is missed (e.g. a dropped WebSocket), the pair
    // already exists, so confirming must still succeed without a fresh token.
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b)
    await markTimerElapsed(roomId)

    // Simulate the missed refresh: B's token stays burned (NULL) after start.
    await env.DB.prepare('UPDATE users SET qr_token = NULL WHERE public_id = ?')
      .bind(b.publicId).run()

    // Confirm with a stale/bogus token — the existing encounter should be honoured.
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-private-token': a.privateToken },
      body: JSON.stringify({ scanneePublicId: b.publicId, qrToken: 'stale-or-burned' }),
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.action).toBe('confirmed')

    const sa = await getScore(roomId, a)
    const sb = await getScore(roomId, b)
    expect(sa.data.score).toBe(1)
    expect(sb.data.score).toBe(1)
  })

  it('self-heals a missed timer: confirms even though the alarm never set notified_at', async () => {
    // If the DurableRoom registration fails right after the D1 insert (worker
    // killed, transient RPC error), no alarm is ever scheduled and notified_at
    // stays NULL forever — the pair would be stuck: unconfirmable ("still in
    // progress") and unable to restart (the encounter row exists). A scan
    // arriving after the timer should have elapsed must repair this inline.
    const { roomId, adminToken } = await createRoom()
    // Use a real timer (the test env default is 0) so this exercises the actual
    // time-based gate: the scan below confirms because started_at is backdated
    // past the duration, not because the duration is degenerate.
    await admin(roomId, adminToken).put('/settings', { encounterDurationSeconds: 300 })
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await scan(roomId, a, b)

    // Simulate the missed alarm: timer long over, notified_at never set.
    await env.DB.prepare(
      'UPDATE encounters SET started_at = started_at - 4000 WHERE room_id = ? AND notified_at IS NULL'
    ).bind(roomId).run()

    const { res, data } = await scan(roomId, a, b)
    expect(res.status).toBe(200)
    expect(data.action).toBe('confirmed')

    const sa = await getScore(roomId, a)
    const sb = await getScore(roomId, b)
    expect(sa.data.score).toBe(1)
    expect(sb.data.score).toBe(1)
  })

  it('atomic burn: two concurrent scans of the same displayed QR start only one session', async () => {
    // Two people photograph/scan A's card at nearly the same instant, so both
    // requests carry the same single-use token. Check-then-burn would let both
    // pass the token check (and the busy guard, read before either insert) and
    // put A in two simultaneous conversations. The conditional burn makes the
    // token consumption atomic: exactly one request wins, the other is rejected.
    const { roomId } = await createRoom()
    const [a, c, d] = [await joinUser(roomId), await joinUser(roomId), await joinUser(roomId)]
    const token = await issueQrToken(roomId, a) // A's one displayed QR

    const scanA = (scanner: typeof c) => fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-private-token': scanner.privateToken },
      body: JSON.stringify({ scanneePublicId: a.publicId, qrToken: token }),
    })
    const [resC, resD] = await Promise.all([scanA(c), scanA(d)])
    const [dataC, dataD] = [await resC.json<any>(), await resD.json<any>()]

    const started = [dataC, dataD].filter((r) => r.action === 'started')
    expect(started.length).toBe(1)

    // The invariant behind the busy guard: A holds at most one encounter.
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM encounters WHERE room_id = ? AND (user_a_id = ? OR user_b_id = ?)'
    ).bind(roomId, a.publicId, a.publicId).first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('still rejects starting a new encounter with an invalid token', async () => {
    // The token check must remain strict for *new* encounters even though it is
    // now relaxed on the confirmation path.
    const { roomId } = await createRoom()
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-private-token': a.privateToken },
      body: JSON.stringify({ scanneePublicId: b.publicId, qrToken: 'bogus' }),
    })
    expect(res.status).toBe(400)
  })
})
