import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  // Read the project's D1 migrations so each isolated test database can be seeded
  // with the full schema (the single 0001_init.sql creates every table).
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))

  return {
    test: {
      silent: 'passed-only' as const,
      projects: [
        {
          // Worker suite — runs inside the real workerd runtime with live D1/DO bindings.
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
            name: 'workers',
            include: ['test/unit/**/*.{test,spec}.ts', 'test/integration/**/*.{test,spec}.ts'],
            setupFiles: ['./test/apply-migrations.ts'],
          },
        },
        {
          // Front-end component logic — the Alpine factory (public/app.js) instantiated
          // in a happy-dom DOM with fetch/WebSocket/crypto stubbed. Covers the
          // deterministic-only branches the Playwright e2e suite cannot reach (the 409
          // mutual-scan race, clock-offset, the scanned-URL parser, the QR retry timer).
          test: {
            name: 'frontend',
            include: ['test/frontend/**/*.{test,spec}.ts'],
            environment: 'happy-dom',
          },
        },
      ],
    },
  }
})
