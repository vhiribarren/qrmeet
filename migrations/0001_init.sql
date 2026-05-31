CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'QRMeet',
  admin_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  ip_salt TEXT NOT NULL DEFAULT '',
  encounter_duration_seconds INTEGER,
  max_participants INTEGER,
  is_open INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE users (
  public_id TEXT PRIMARY KEY,
  private_token TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Anonymous',
  emoji TEXT NOT NULL DEFAULT '😊',
  ip_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_users_room ON users(room_id);
CREATE INDEX idx_users_private_token ON users(private_token);

CREATE TABLE encounters (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_a_id TEXT NOT NULL REFERENCES users(public_id),
  user_b_id TEXT NOT NULL REFERENCES users(public_id),
  started_at INTEGER NOT NULL,
  notified_at INTEGER,
  closed_at INTEGER,
  counted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(room_id, user_a_id, user_b_id)
);

CREATE INDEX idx_encounters_room ON encounters(room_id);
CREATE INDEX idx_encounters_users ON encounters(user_a_id, user_b_id);
