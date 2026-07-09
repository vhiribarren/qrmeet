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
 * Writes public/version.json (gitignored), the static asset the landing/about
 * footer fetches to show the build identifier. Run before serving or deploying:
 * automatically via the `predev` / `predeploy` npm hooks, and in CI as part of
 * `npm run build`.
 *
 * The identifier is a `git describe` string, which encodes in one token: the
 * last release tag, the number of commits since it, the short SHA, and a -dirty
 * suffix when the working tree has uncommitted changes. Examples:
 *   - "v1.1.0"                 — exactly on the tag, clean
 *   - "v1.1.0-dirty"           — on the tag with uncommitted changes
 *   - "v1.1.0-3-g1a2b3c4"      — 3 commits past the tag, at 1a2b3c4
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const OUTPUT = 'public/version.json'

// Run a git command, capturing stdout and silencing stderr so expected failures
// (no repo, no tags — e.g. Cloudflare's shallow checkout) don't spam build logs.
function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function buildIdentifier() {
  // Primary: `git describe`, the standard version+distance+sha+dirty identifier.
  try {
    return git('describe --tags --dirty')
  } catch {
    // No reachable tag (e.g. Cloudflare's shallow checkout without tags): compose
    // the package.json version with whatever commit info is still available.
    const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
    const sha = process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 7) ?? tryGit('rev-parse --short HEAD')
    const dirty = tryGit('status --porcelain').length > 0
    return `v${pkgVersion}${sha ? `-g${sha}` : ''}${dirty ? '-dirty' : ''}`
  }
}

// Best-effort git call: empty string on failure (no repo).
function tryGit(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

const version = buildIdentifier()
writeFileSync(OUTPUT, JSON.stringify({ version }) + '\n')
console.log(`gen-version: wrote ${OUTPUT} (${version})`)
