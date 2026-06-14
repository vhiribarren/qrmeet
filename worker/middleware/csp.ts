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

import { MiddlewareHandler } from 'hono'

/**
 * Middleware to set Content-Security-Policy (CSP) header on HTML responses.
 * Rebuilds the response to bypass immutable header limitations of static assets.
 *
 * @param directives List of CSP directives
 */
export function csp(directives: string[]): MiddlewareHandler {
  const cspHeaderValue = directives.join('; ')

  return async (c, next) => {
    await next()
    const contentType = c.res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return

    // ASSETS responses have immutable headers, so rebuild the response to set them.
    const res = new Response(c.res.body, c.res)
    res.headers.set('Content-Security-Policy', cspHeaderValue)
    c.res = res
  }
}
