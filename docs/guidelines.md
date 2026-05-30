# Development guidelines

> This file serves as development guidelines for both human contributors and AI coding agents.
> Rules here are binding — follow them exactly, even when they conflict with general best practices or defaults.
>
> **AI coding agent setup:** load this file and the other docs listed below into your agent's context. Most agents support a project-level instructions file for this purpose.
> - `docs/guidelines.md` — rules and conventions (this file)
> - `docs/architecture.md` — stack, data model, infrastructure, design decisions
> - `docs/api.md` — full API endpoint reference
> - `docs/flows.md` — user flows, state machines, sequence diagrams
> - `README.md` — product overview, security model, dev scripts
>
> *Example — Claude Code:* create `.claude/CLAUDE.md` at the project root:
> ```
> @docs/guidelines.md
> @docs/architecture.md
> @docs/flows.md
> @README.md
> ```

## Dependencies

- **No contaminating licenses.** All dependencies (direct and transitive) must use permissive
  licenses compatible with proprietary deployment as SaaS, PWA, or Tauri binary: MIT, ISC,
  BSD-2/3-Clause, Apache-2.0, and 0BSD are allowed. GPL, LGPL, AGPL, MPL, and any other
  copyleft license are forbidden. Verify with `npx license-checker` before
  adding any new dependency.

- **Keep license files in sync.** Whenever a dependency is added, removed, or updated
  (direct or transitive — e.g. after `npm install` or a lockfile change), update both:
  - `THIRD_PARTY_LICENSES.md` at the project root
  - the about page
  Remove the library versions.

## CSS

- **No inline styles.** Never use inline styles for layout or theming.
- **BEM convention.** Apply the BEM CSS methodoloy to name and organize CSS classes.

## Legal and regulatory compliance

- **Review on data model changes.** Any change to what data is collected, stored, or
  processed (new fields, new entity types, new storage mechanisms) must be checked against
  the following:
  - **GDPR/RGPD**: does the change involve new personal data about third parties (names,
    emails, roles, activity)? If so, flag it — the user (as data controller) must be
    informed, and the Privacy section of the About screen may need updating.
  - **ePrivacy**: no cookies or tracking may be introduced without raising the topic first.

  If a proposed change is not clearly compatible, raise the concern and propose adjustments
  before implementing.

## GitHub commits

- **Conventional Commits messages.** [Conventional
  Commits](https://www.conventionalcommits.org/en/v1.0.0/) should be used as
  much as possible as common message commit practice.


## Always

- **Document synchronization.** After any change to business logic, data model,
  API, or infrastructure, check and update the relevant files in `docs/`:
  - `docs/architecture.md` — data model, infrastructure, design decisions
  - `docs/api.md` — API routes and endpoint reference
  - `docs/flows.md` — user flows, state machines, sequence diagrams
  - `public/index.html` (Privacy section) — if data collection or third-party services change
- **English only.** By default, all strings, labels, error messages,
  placeholders, aria-labels, and comments must be in English.
- **License header.** Every new source file must start with the MIT copyright block, adapted to the file format:

  `.ts`, `.tsx`, `.js`, `.css`:
  ```
  /**
   * MIT License
   *
   * Copyright (c) 2026 Vincent Hiribarren
   * ...
   */
  ```

  `.html` — place the comment **after** the `<!DOCTYPE html>` declaration:
  ```
  <!DOCTYPE html>
  <!--
  MIT License

  Copyright (c) 2026 Vincent Hiribarren
  ...
  -->
  ```

  Full license text:
  ```
  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

  Update the year if it changes, or the author if the file is created by someone different from the main author.
