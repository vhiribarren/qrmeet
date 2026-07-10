import type { DurableRoom } from '../durable/DurableRoom'

export async function purgeRoom(
  db: D1Database,
  durableRoom: DurableObjectNamespace,
  roomId: string
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM treasure_scans WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM treasures WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM encounters WHERE room_id = ?').bind(roomId),
    // Only the passkey<->room association dies with the room; the credential
    // itself (passkeys table) survives so the same passkey works at the next
    // event. Stale credentials are pruned by the cron after ~365 days unused.
    db.prepare('DELETE FROM passkey_links WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM users WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId),
  ])
  const stub = durableRoom.get(durableRoom.idFromName(roomId)) as unknown as DurableObjectStub<DurableRoom>
  await stub.cleanup()
}
