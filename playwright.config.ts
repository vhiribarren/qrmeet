import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8787'

// End-to-end suite for the Alpine.js front-end. Drives two (or more) real
// browser contexts — one per "phone" — against a live `wrangler dev`, so the
// WebSocket push path and Alpine rendering are exercised for real. The camera
// is never used: scans are performed by navigating the scan URL directly, which
// is exactly what init() does for a cold scan deep-link.
export default defineConfig({
  testDir: './e2e',
  // One backend (D1 + Durable Objects) is shared by every test. Rooms are
  // isolated by id, but a single worker keeps WebSocket timing deterministic.
  workers: 1,
  fullyParallel: false,
  // Generous per-test budget: a live `wrangler dev` occasionally stalls a few
  // seconds (cold recompile, Durable Object spin-up). One retry absorbs those
  // infra hiccups without masking a real logic failure (which fails both runs).
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    testIdAttribute: 'data-test',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'wrangler dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
