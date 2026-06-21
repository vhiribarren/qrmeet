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
  })

  it('rejects scanning yourself', async () => {
    const { roomId } = await createRoom()
    const a = await joinUser(roomId)
    const { res } = await scan(roomId, a, a)
    expect(res.status).toBe(400)
  })

  it('rejects a second scan while the encounter is still running', async () => {
    const { roomId } = await createRoom()
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
})
