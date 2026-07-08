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

### Changed

- The board tabs are now ordered Join, Graph, then Top score.
- The encounter graph stays readable with large rooms: you can now zoom and pan,
  node size reflects how many people someone has met, and tapping a node focuses
  it — dimming the rest and highlighting its direct connections. The view no
  longer resets when new encounters come in.

### Fixed

- The leaderboard's total number of meetings now matches the admin page — it no
  longer undercounts when there are more participants than the leaderboard shows.

## [1.0.1] - 2026-07-05

### Fixed

- A finished meeting can no longer be confirmed while you're still chatting with
  someone else — wait until your current conversation ends.

## [1.0.0] - 2026-07-04

### Added

- First version

[Unreleased]: https://github.com/vhiribarren/qrmeet/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/vhiribarren/qrmeet/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vhiribarren/qrmeet/releases/tag/v1.0.0
