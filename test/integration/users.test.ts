import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, issueQrToken, getScore, admin, fetchWorker, BASE } from '../helpers'

describe('users', () => {
  it('joins a room and returns credentials', async () => {
    const { roomId } = await createRoom()
    const u = await joinUser(roomId)
    expect(u.publicId).toMatch(/^[a-z0-9]{12}$/)
    expect(u.privateToken).toMatch(/^[A-Za-z0-9]{32}$/)
  })

  it('enforces the maximum participant count', async () => {
    const { roomId, adminToken } = await createRoom()
    await admin(roomId, adminToken).put('/settings', { maxParticipants: 1 })
    await joinUser(roomId) // 1st ok
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users`, { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('rejects joining a closed room', async () => {
    const { roomId, adminToken } = await createRoom()
    await admin(roomId, adminToken).put('/settings', { isOpen: false })
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/users`, { method: 'POST' })
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
