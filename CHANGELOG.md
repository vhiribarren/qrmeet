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

### Added

- App version and build revision on the landing and About pages.

## [1.1.0] - 2026-07-08

### Changed

- Board tabs reordered to Join, Graph, Top score, opening on Join.
- The encounter graph supports zoom, pan, and node focus, and stays readable
  in large rooms.

### Fixed

- Leaderboard meeting total matches the admin page.

## [1.0.1] - 2026-07-05

### Fixed

- A finished meeting can no longer be confirmed while you're still chatting with
  someone else — wait until your current conversation ends.

## [1.0.0] - 2026-07-04

### Added

- First version

[Unreleased]: https://github.com/vhiribarren/qrmeet/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/vhiribarren/qrmeet/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/vhiribarren/qrmeet/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vhiribarren/qrmeet/releases/tag/v1.0.0
