import { describe, it, expect } from 'vitest'
import { createRoom, joinUser, completeEncounter, claimTreasure, createTreasure, fetchWorker, BASE } from '../helpers'

async function boardScores(roomId: string) {
  const res = await fetchWorker(`${BASE}/api/rooms/${roomId}/board/scores`)
  return res.json() as Promise<any>
}

describe('public board', () => {
  it('reports a unified score with the meetings/treasure breakdown', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken, { points: 3 })
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]

    await completeEncounter(roomId, a, b) // +1 meeting each
    await claimTreasure(roomId, a, tid)   // +3 treasure for a

    const board = await boardScores(roomId)
    const rowA = board.scores.find((s: any) => s.public_id === a.publicId)
    const rowB = board.scores.find((s: any) => s.public_id === b.publicId)

    expect(rowA).toMatchObject({ score: 4, meetings: 1, treasures: 1, treasure_points: 3 })
    expect(rowB).toMatchObject({ score: 1, meetings: 1, treasures: 0, treasure_points: 0 })
    expect(board.totalParticipants).toBe(2)
  })

  it('orders by score descending', async () => {
    const { roomId, adminToken } = await createRoom()
    const tid = await createTreasure(roomId, adminToken, { points: 5 })
    const [a, b] = [await joinUser(roomId), await joinUser(roomId)]
    await claimTreasure(roomId, b, tid) // b leads with 5

    const board = await boardScores(roomId)
    expect(board.scores[0].public_id).toBe(b.publicId)
    expect(board.scores[0].score).toBe(5)
  })

  it('caps the public leaderboard at 10 rows', async () => {
    const { roomId } = await createRoom()
    for (let i = 0; i < 11; i++) await joinUser(roomId)
    const board = await boardScores(roomId)
    expect(board.scores.length).toBe(10)
    expect(board.totalParticipants).toBe(11)
  })

  it('reports totalMeetings over all encounters, not just the capped leaderboard', async () => {
    const { roomId } = await createRoom()
    // 12 players (> boardTopSize of 10) so some meetings fall outside the returned rows.
    const users = []
    for (let i = 0; i < 12; i++) users.push(await joinUser(roomId))
    // Six disjoint pairs → six confirmed meetings.
    for (let i = 0; i < 12; i += 2) await completeEncounter(roomId, users[i], users[i + 1])

    const board = await boardScores(roomId)
    expect(board.scores.length).toBe(10)
    // Summing the capped rows' `meetings` (10 rows × 1 / 2 = 5) would undercount; the
    // server-side total counts every confirmed encounter.
    expect(board.totalMeetings).toBe(6)
  })
})
