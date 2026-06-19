# Security Policy

cursorsync reads and writes your **local Cursor chat database** and syncs chat content to a
backend you control (your own Supabase + PowerSync instance). Because it touches private data,
we take security seriously.

## What cursorsync does and does not handle

- **Your data goes to your own infrastructure.** cursorsync ships with no hosted backend. You
  configure your own Supabase project and PowerSync instance via a local, gitignored `.env`.
- **No secrets in the repo.** Only the Supabase **anon** key (Row-Level-Security scoped) is ever
  used by the client. The Supabase `service_role` key is never read, referenced, or required.
- **Local DB safety.** Reads use a read-only SQLite connection; writes are backup-first and never
  open Cursor's live database read-write.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, use GitHub's private
[Security Advisories](https://github.com/lokeylabs/cursorsync/security/advisories/new) to
report privately. We aim to acknowledge within 72 hours.

When reporting, include: affected version/commit, reproduction steps, and impact assessment.

## Supported versions

This project is pre-1.0; only the latest `main` is supported during early development.
