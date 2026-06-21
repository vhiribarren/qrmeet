import { describe, it, expect } from 'vitest'
import { createRoom, fetchWorker, BASE } from '../helpers'

describe('rooms', () => {
  it('creates a room and fetches its metadata', async () => {
    const { roomId, data } = await createRoom({ name: 'Hello' })
    expect(roomId).toMatch(/^[a-z0-9]{6}$/)
    expect(data.name).toBe('Hello')

    const res = await fetchWorker(`${BASE}/api/rooms/${roomId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).id).toBe(roomId)
  })

  it('seeds the default questions on creation', async () => {
    const { roomId, adminToken } = await createRoom()
    const res = await fetchWorker(`${BASE}/api/admin/rooms/${roomId}/questions`, {
      headers: { 'x-admin-token': adminToken },
    })
    const data = (await res.json()) as any
    expect(data.questions.length).toBeGreaterThanOrEqual(20)
  })

  it('returns 404 for an unknown room', async () => {
    const res = await fetchWorker(`${BASE}/api/rooms/nope00`)
    expect(res.status).toBe(404)
  })
})
