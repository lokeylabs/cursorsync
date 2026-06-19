# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- pnpm workspace monorepo with shared TypeScript, ESLint, Prettier, and CI.
- `@cursorsync/cursor-store`: pure read/write adapter for Cursor's `state.vscdb` (safe read-only
  open, namespace-scoped extraction, rowid + hash delta detection).
- `@cursorsync/sync-engine`: row→record transform, env-based config loader.
- Cursor / VS Code extension scaffold (bridge host).
- Supabase schema + PowerSync sync rules.
- Architecture, security, and contribution docs.

### Notes

- Read-only extraction and up-sync delta detection are validated against a real 27 GB Cursor DB.
- Down-sync writer, PowerSync/Supabase wiring, and `.vsix` packaging are in progress.

[Unreleased]: https://github.com/lokeylabs/cursorsync/commits/main
