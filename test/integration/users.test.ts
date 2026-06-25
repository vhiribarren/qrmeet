import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, newPrivateToken, issueQrToken, getScore, admin, fetchWorker, BASE } from '../helpers'

const joinWith = (roomId: string, body: unknown) =>
  fetchWorker(`${BASE}/api/rooms/${roomId}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('users', () => {
  it('joins a room and returns credentials', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    expect(u.publicId).toMatch(/^[a-z0-9]{12}$/)
    expect(u.privateToken).toMatch(/^[A-Za-z0-9]{32,128}$/)
  })

  it('rejects a join with a missing or malformed private token', async () => {
    const { roomId } = await createRoom()
    expect((await joinWith(roomId, {})).status).toBe(400)
    expect((await joinWith(roomId, { privateToken: 'too-short' })).status).toBe(400)
  })

  it('is idempotent: re-posting the same token returns the same account', async () => {
    const { roomId } = await createRoom()
    const token = newPrivateToken()
    const first = await joinUser(roomId, token)
    const second = await joinUser(roomId, token)
    expect(second.publicId).toBe(first.publicId)
    // Distinct people on the same IP still get distinct accounts.
    const other = await joinUser(roomId)
    expect(other.publicId).not.toBe(first.publicId)
  })

  it('enforces the maximum participant count', async () => {
    const { roomId, adminToken } = await createRoom()
    await admin(roomId, adminToken).put('/settings', { maxParticipants: 1 })
    await joinUser(roomId) // 1st ok
    const res = await joinWith(roomId, { privateToken: newPrivateToken() })
    expect(res.status).toBe(403)
  })

  it('rejects joining a closed room', async () => {
    const { roomId, adminToken } = await createRoom()
    await admin(roomId, adminToken).put('/settings', { isOpen: false })
    const res = await joinWith(roomId, { privateToken: newPrivateToken() })
    expect(res.status).toBe(403)
  })

  it('updates the profile (name + emoji)', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users/${u.publicId}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-private-token': u.privateToken },
      body: JSON.stringify({ displayName: 'Alice', emoji: '🦁' }),
    })
    expect(res.status).toBe(200)
    const score = await getScore(roomId, u)
    expect(score.data.displayName).toBe('Alice')
    expect(score.data.emoji).toBe('🦁')
  })

  it('issues a QR token', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    expect(await issueQrToken(roomId, u)).toBeTruthy()
  })

  it('rejects an unauthenticated score request', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users/${u.publicId}/score`)
    expect(res.status).toBe(401)
  })

  it('returns a zeroed score shape for a fresh user', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    const { data } = await getScore(roomId, u)
    expect(data).toMatchObject({ score: 0, meetings: 0, treasurePoints: 0, treasuresFound: 0 })
    expect(data.encounters).toEqual([])
  })
})
