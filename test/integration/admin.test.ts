import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, claimTreasure, createTreasure, getScore, admin, fetchWorker, BASE } from '../helpers'

describe('admin auth', () => {
  it('rejects requests without an admin token', async () => {
    const { roomId } = await createRoom()
    const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}/scores`)
    expect(res.status).toBe(401)
  })

  it('rejects a wrong admin token', async () => {
    const { roomId } = await createRoom()
    const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}/scores`, {
      headers: { 'x-admin-token': 'wrong' },
    })
    expect(res.status).toBe(401)
  })
})

describe('admin settings', () => {
  it('exposes settings including treasure + TTL fields', async () => {
    const { roomId, adminToken } = await createRoom()
    const { data } = await admin(roomId, adminToken).get('/settings')
    expect(data).toMatchObject({
      treasureHuntEnabled: false,
      treasureDefaultPoints: 3,
      roomTtlDays: 7,
    })
  })

  it('merges updates (only provided fields change)', async () => {
    const { roomId, adminToken } = await createRoom()
    const a = admin(roomId, adminToken)
    await a.put('/settings', { maxParticipants: 50 })
    await a.put('/settings', { treasureHuntEnabled: true })
    const { data } = await a.get('/settings')
    expect(data.maxParticipants).toBe(50)
    expect(data.treasureHuntEnabled).toBe(true)
  })

  it('validates treasureDefaultPoints', async () => {
    const { roomId, adminToken } = await createRoom()
    const { res } = await admin(roomId, adminToken).put('/settings', { treasureDefaultPoints: 0 })
    expect(res.status).toBe(400)
  })
})

describe('admin treasure CRUD', () => {
  it('creates, lists, updates and deletes treasures', async () => {
    const { roomId, adminToken } = await createRoom()
    const a = admin(roomId, adminToken)
    await a.put('/settings', { treasureHuntEnabled: true, treasureDefaultPoints: 3 })

    const created = await a.post('/treasures', { label: 'Door' })
    expect(created.res.status).toBe(201)
    const tid = created.data.id

    let list = await a.get('/treasures')
    expect(list.data.defaultPoints).toBe(3)
    const row = list.data.treasures.find((t: any) => t.id === tid)
    expect(row.points).toBeNull()
    expect(row.effectivePoints).toBe(3) // inherits default

    await a.put(`/treasures/${tid}`, { points: 9, label: 'Lobby' })
    list = await a.get('/treasures')
    expect(list.data.treasures.find((t: any) => t.id === tid).effectivePoints).toBe(9)

    const del = await a.del(`/treasures/${tid}`)
    expect(del.res.status).toBe(200)
    list = await a.get('/treasures')
    expect(list.data.treasures.length).toBe(0)
  })
})

describe('admin renew', () => {
  it('resets the expiry to now + ROOM_TTL_DAYS and never exceeds it', async () => {
    const { roomId, adminToken } = await createRoom()
    const a = admin(roomId, adminToken)
    const cap = Math.floor(Date.now() / 1000) + 7 * 86400

    const first = await a.post('/renew')
    expect(first.res.status).toBe(200)
    expect(first.data.roomTtlDays).toBe(7)
    expect(first.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(first.data.expiresAt).toBeLessThanOrEqual(cap + 2)

    const second = await a.post('/renew')
    expect(second.data.expiresAt).toBeLessThanOrEqual(cap + 2) // does not stack beyond the cap
  })
})

describe('admin destructive ops', () => {
  it('deleting a user removes them and their treasure scans', async () => {
    const { roomId, adminToken } = await createRoom()
    const a = admin(roomId, adminToken)
    const tid = await createTreasure(roomId, adminToken)
    const u = await joinUser(roomId)
    await claimTreasure(roomId, u, tid)

    const del = await a.del(`/users/${u.publicId}`)
    expect(del.res.status).toBe(200)

    // The user is gone — their authenticated score request now fails.
    const score = await getScore(roomId, u)
    expect(score.res.status).toBe(401)

    const board = await fetchWorker(`${BASE}/api/rooms/${roomId}/board/scores`)
    expect(((await board.json()) as any).totalParticipants).toBe(0)
  })

  it('deleting a room purges it', async () => {
    const { roomId, adminToken } = await createRoom()
    await admin(roomId, adminToken).del('')
    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}`)
    expect(res.status).toBe(404)
  })
})
