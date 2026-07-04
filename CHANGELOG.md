# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions follow a pragmatic `major.minor.patch` scheme — not strict SemVer,
which is an API-compatibility contract this end-user app doesn't need:

- **major** — massive evolutions (redesign, new game mode, architectural overhaul)
- **minor** — functional updates (new or changed features)
- **patch** — bug fixes only

When a batch of changes is deployed, the `[Unreleased]` section is renamed to
`## [x.y.z] - YYYY-MM-DD` and the version in `package.json` is bumped to match —
both handled by `npm run release` (see `docs/guidelines.md`).

## [Unreleased]

## [1.0.0] - 2026-07-04

### Added

- First version
