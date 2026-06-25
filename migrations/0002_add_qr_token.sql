-- Move the single-use scan token from Workers KV into D1. KV is eventually
-- consistent, so a freshly issued token could read back stale/missing from
-- another edge location, surfacing "Invalid or expired QR code" on a QR the
-- user had just refreshed. D1 is strongly consistent and the token lives on the
-- existing users row (overwritten on refresh, set NULL when burned), so no
-- expiry/cleanup is needed — the token is single-use and rotated constantly.

ALTER TABLE users ADD COLUMN qr_token TEXT;
