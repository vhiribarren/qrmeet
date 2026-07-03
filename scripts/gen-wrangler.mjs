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
 * Generates wrangler.toml from wrangler.ci.toml by substituting ${NAME}
 * placeholders with environment variables.
 *
 * This lets deployment-specific values (the D1 database id, the custom domain)
 * stay out of the public repository: they are provided as encrypted build
 * variables in the Cloudflare Workers Builds settings and injected here at
 * deploy time. Run as the Cloudflare "build command":
 *
 *   node scripts/gen-wrangler.mjs
 *
 * The generated wrangler.toml is gitignored and must never be committed.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const TEMPLATE = 'wrangler.ci.toml'
const OUTPUT = 'wrangler.toml'

const template = readFileSync(TEMPLATE, 'utf8')

const missing = new Set()
const output = template.replace(/\$\{(\w+)\}/g, (_match, name) => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    missing.add(name)
    return ''
  }
  return value
})

if (missing.size > 0) {
  console.error(
    `gen-wrangler: missing required environment variable(s): ${[...missing].join(', ')}`,
  )
  console.error(
    'Set them as build variables in the Cloudflare Workers Builds settings.',
  )
  process.exit(1)
}

writeFileSync(OUTPUT, output)
console.log(`gen-wrangler: wrote ${OUTPUT} from ${TEMPLATE}`)
