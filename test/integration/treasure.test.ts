import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, claimTreasure, getScore, admin, createTreasure } from '../helpers'

describe('treasure hunt', () => {
  it('claims a treasure and awards the room default points', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken) // inherits default (3)
    const u = await joinUser(roomId)

    const { res, data } = await claimTreasure(roomId, u, tid)
    expect(res.status).toBe(200)
    expect(data.action).toBe('claimed')
    expect(data.points).toBe(3)

    const s = await getScore(roomId, u)
    expect(s.data.score).toBe(3)
    expect(s.data.treasurePoints).toBe(3)
    expect(s.data.treasuresFound).toBe(1)
  })

  it('lets a player claim a given treasure only once', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken)
    const u = await joinUser(roomId)
    await claimTreasure(roomId, u, tid)

    const { res, data } = await claimTreasure(roomId, u, tid)
    expect(res.status).toBe(200)
    expect(data.action).toBe('already_claimed')
    expect((await getScore(roomId, u)).data.score).toBe(3)
  })

  it('honours a per-treasure points override', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken, { points: 10 })
    const u = await joinUser(roomId)
    const { data } = await claimTreasure(roomId, u, tid)
    expect(data.points).toBe(10)
  })

  it('snapshots awarded points; changing the default does not rewrite earned points', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken) // inherits 3
    const u1 = await joinUser(roomId)
    await claimTreasure(roomId, u1, tid) // +3 snapshotted

    await admin(roomId, adminToken).put('/settings', { treasureDefaultPoints: 5 })
    const u2 = await joinUser(roomId)
    const { data } = await claimTreasure(roomId, u2, tid)
    expect(data.points).toBe(5) // new claim uses the new default

    expect((await getScore(roomId, u1)).data.treasurePoints).toBe(3) // unchanged
  })

  it('rejects a disabled treasure', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken)
    await admin(roomId, adminToken).put(`/treasures/${tid}`, { enabled: false })
    const u = await joinUser(roomId)
    const { res } = await claimTreasure(roomId, u, tid)
    expect(res.status).toBe(403)
  })

  it('rejects claims when treasure hunt is turned off for the room', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken)
    await admin(roomId, adminToken).put('/settings', { treasureHuntEnabled: false })
    const u = await joinUser(roomId)
    const { res } = await claimTreasure(roomId, u, tid)
    expect(res.status).toBe(403)
  })

  it('blocks claims when the game is paused', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken)
    await admin(roomId, adminToken).put('/settings', { scanningEnabled: false })
    const u = await joinUser(roomId)
    const { res } = await claimTreasure(roomId, u, tid)
    expect(res.status).toBe(403)
  })

  it('returns 404 for an unknown treasure', async () => {
    const { roomId, adminToken } = await createRoom()
    await createTreasure(roomId, adminToken) // enables the hunt
    const u = await joinUser(roomId)
    const { res } = await claimTreasure(roomId, u, 'doesnotexist')
    expect(res.status).toBe(404)
  })

  it('deleting a treasure removes its scans and lowers scores', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken)
    const u = await joinUser(roomId)
    await claimTreasure(roomId, u, tid)
    expect((await getScore(roomId, u)).data.score).toBe(3)

    await admin(roomId, adminToken).del(`/treasures/${tid}`)
    const s = await getScore(roomId, u)
    expect(s.data.score).toBe(0)
    expect(s.data.treasuresFound).toBe(0)
  })
})
