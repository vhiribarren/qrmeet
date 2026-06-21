/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from '../worker/lib/types'
import type { D1Migration } from '@cloudflare/vitest-pool-workers'

// `env` from "cloudflare:test" is typed as Cloudflare.Env. Give it our worker
// bindings plus the migrations array injected via miniflare in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
