import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Seed the isolated test database with the project's D1 migrations before each
// test file runs. applyD1Migrations tracks what it has applied, so this is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
