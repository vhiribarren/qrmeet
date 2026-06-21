import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  // Read the project's D1 migrations so each isolated test database can be seeded
  // with the full schema (the single 0001_init.sql creates every table).
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))

  return {
    plugins: [
      cloudflareTest({
        // Reuse the real bindings (DB, QR_TOKENS, DURABLE_ROOM, ASSETS) and [vars].
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            // Consumed by test/apply-migrations.ts.
            TEST_MIGRATIONS: migrations,
            // Encounters expire immediately so the confirm path can be driven by
            // firing the Durable Object alarm, with no real waiting.
            ENCOUNTER_DURATION_SECONDS: '0',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // Suppress worker console output for passing tests; keep it when a test fails.
      silent: 'passed-only',
    },
  }
})
