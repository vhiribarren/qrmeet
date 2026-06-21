/**
 * MIT License
 *
 * Copyright (c) 2026 Vincent Hiribarren
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * One-shot Cloudflare bootstrap: creates the D1 database and KV namespace,
 * writes their IDs into wrangler.toml, and applies the remote migrations.
 *
 * Safe to re-run: each step is skipped when wrangler.toml already holds a real
 * value (the `<your-…>` placeholders are the only trigger for creation).
 *
 * Prerequisite: `npx wrangler login` (the script tells you if you're not).
 */

import { execSync } from 'node:child_process'
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const TOML = 'wrangler.toml'
const SAMPLE = 'wrangler.toml.sample'
const DB_NAME = 'qrmeet-db'
const KV_BINDING = 'QRMEET_TOKENS'
const D1_PLACEHOLDER = '<your-d1-database-id>'
const KV_PLACEHOLDER = '<your-kv-namespace-id>'

function run(cmd: string): string {
  console.log(`\n$ ${cmd}`)
  return execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
}

function readToml(): string {
  return readFileSync(TOML, 'utf8')
}

// 0. Ensure wrangler.toml exists (copy from the committed sample).
if (!existsSync(TOML)) {
  if (!existsSync(SAMPLE)) {
    console.error(`✗ Neither ${TOML} nor ${SAMPLE} found. Run from the project root.`)
    process.exit(1)
  }
  copyFileSync(SAMPLE, TOML)
  console.log(`✓ Created ${TOML} from ${SAMPLE}`)
}

// 1. D1 database — create only if the placeholder is still present.
if (readToml().includes(D1_PLACEHOLDER)) {
  console.log(`\n▶ Creating D1 database "${DB_NAME}"…`)
  const out = run(`npx wrangler d1 create ${DB_NAME}`)
  const id = out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1]
  if (!id) {
    console.error('✗ Could not parse database_id from wrangler output. Paste it into wrangler.toml manually.')
    process.exit(1)
  }
  writeFileSync(TOML, readToml().replace(D1_PLACEHOLDER, id))
  console.log(`✓ D1 database_id written to ${TOML}: ${id}`)
} else {
  console.log('• D1 database_id already set — skipping create.')
}

// 2. KV namespace — create only if the placeholder is still present.
if (readToml().includes(KV_PLACEHOLDER)) {
  console.log(`\n▶ Creating KV namespace "${KV_BINDING}"…`)
  const out = run(`npx wrangler kv namespace create ${KV_BINDING}`)
  const id = out.match(/id\s*=\s*"([0-9a-f]{32})"/i)?.[1]
  if (!id) {
    console.error('✗ Could not parse the KV namespace id from wrangler output. Paste it into wrangler.toml manually.')
    process.exit(1)
  }
  writeFileSync(TOML, readToml().replace(KV_PLACEHOLDER, id))
  console.log(`✓ KV namespace id written to ${TOML}: ${id}`)
} else {
  console.log('• KV namespace id already set — skipping create.')
}

// 3. Apply the schema to the remote database.
console.log('\n▶ Applying migrations to the remote D1 database…')
run(`npx wrangler d1 migrations apply ${DB_NAME} --remote`)

console.log('\n✅ Bootstrap complete. Next step: npm run deploy')
