-- Passkey-based profile recovery.
--
-- `passkeys` holds one row per WebAuthn credential (public key + opaque ids,
-- no personal data). It is deliberately NOT room-scoped: the same passkey is
-- reused across events — only the passkey<->room association (`passkey_links`)
-- dies with the room. Stale credentials are pruned by the hourly cron after
-- ~365 days without use.

CREATE TABLE passkeys (
  credential_id TEXT    PRIMARY KEY,            -- base64url, as sent by the authenticator
  public_key    TEXT    NOT NULL,               -- base64url (COSE public key bytes)
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                           -- JSON array or NULL
  person_id     TEXT    NOT NULL,               -- opaque WebAuthn userHandle, no FK anywhere
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One profile per credential per room. No CASCADE, project style: explicit
-- deletes in purgeRoom() and the admin user-delete route.
CREATE TABLE passkey_links (
  credential_id  TEXT NOT NULL REFERENCES passkeys(credential_id),
  room_id        TEXT NOT NULL,
  user_public_id TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (credential_id, room_id)
);

CREATE INDEX idx_passkey_links_room ON passkey_links(room_id);
CREATE INDEX idx_passkey_links_user ON passkey_links(room_id, user_public_id);
