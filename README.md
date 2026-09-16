# SIPastPapers

Private, in-progress project. A searchable archive of historical Solomon
Islands national examination papers (SIF3/SIJSC otherwise known as Year 9, SISC Level 1 otherwise known as Year 11, SISC Level
2/SINF6 otherwise known as Year 12), built for public use.

**Status:** Phase 3 — Next.js app backed by a real Postgres (Neon) database
and file storage (local filesystem by default, Cloudflare R2 optional —
see "What's implemented" below). No authentication, no public
release.

See [`PROJECT_SPEC.md`](./PROJECT_SPEC.md) for the full technical and
governance specification. This README only describes what currently exists
in the repository.

## What's implemented

- **Next.js + TypeScript app** (App Router) at the repo root.
- **Database**: real Postgres, hosted on Neon. No local/offline fallback —
  see "Why no dual-mode" below and
  [`migrations/README.md`](./migrations/README.md) for the one-time
  `npm run db:migrate` setup (schema + reference/taxonomy seed data: exam
  series names, subject names, a placeholder year scaffold — no fabricated
  exam content). Queries go through the plain `pg` client in
  [`src/lib/db/client.ts`](./src/lib/db/client.ts) — no ORM.
- **Public pages**, reading live from that database via
  [`src/lib/db/queries.ts`](./src/lib/db/queries.ts):
  - `/` — homepage with search bar and exam level / year / subject selectors.
  - `/results` — filtered results table (published artifacts only).
  - `/browse` — year × subject coverage matrix per exam series (public-safe:
    only shows "published" / "not yet recovered" / "no record yet").
  - `/exams/[series]/[year]/[subject]/[artifact]` — document page, 404s if
    nothing published exists at that address.
  - `/about` — project purpose, ownership, rights statement, correction process.
  - Everything gracefully falls back to an empty state — the database starts
    with zero artifacts.
- **Admin** — a local CLI, not a web UI (spec section 11):
  `npm run cli -- <command>`, implemented in
  [`scripts/cli.ts`](./scripts/cli.ts). No authentication of its own — it
  only ever runs locally, connecting straight to Postgres and whichever
  storage backend is configured, the same as any other developer script.
  - `ingest <file|directory> --series --year --subject [...]` — hashes the
    file, stores it via `LocalFilesystemStorage`, inserts the artifact,
    and — regardless of any other flags — always inserts a
    `rights_records` row pinned to
    `rights_status = 'pending_institutional_approval'` with basis,
    approved_by and evidence_uri left null. Pointed at a directory, it
    batch-ingests every `.pdf` inside, inferring artifact type and paper
    number from each filename (`<type-slug>_<paper-no>.pdf`). `--dry-run`
    (either form) prints what would happen — per-file inferred metadata,
    or why a file can't be parsed / isn't a valid PDF — without touching
    the database or storage; run this before any real batch.
  - `approve-rights <artifact-id> --basis <value> --approved-by --evidence-uri` —
    the only way those three fields get filled in. `--basis` is a fixed
    enum (`teacher-verified` / `personal-collection` /
    `institutional-submission` / `other`), not free text — see spec
    section 11.2 for what each value means and an important caveat about
    what `--approved-by` does (and doesn't) mean right now.
  - `publish <artifact-id>` — the only place status becomes `published`.
    Refuses, printing exactly what's missing, unless the rights record
    already has basis, approved_by and evidence_uri set. This safeguard
    didn't exist in the old admin web UI.
  - `unpublish <artifact-id>` — takes a published artifact back off the
    public site; there was previously no way to do this at all.
  - `list` — every artifact with its id/status/rights status.
  - `coverage` — the year × subject matrix (spec section 11.3): every
    exam-instance × subject combination, with each cell's real status
    (`published`, `verified_pending_rights`, `missing`, or
    `not_yet_recovered`) derived from what's actually in the database.
- **Storage abstraction**: [`src/lib/storage/`](./src/lib/storage/) defines
  a `StorageProvider` interface (spec section 5) with two implementations,
  switched via `STORAGE_BACKEND` (see `.env.example`):
  - `local` (default) — `LocalFilesystemStorage`, writing under
    `/local-storage` (gitignored). No configuration needed.
  - `r2` — `R2Storage`, Cloudflare R2 via the AWS S3 SDK against R2's
    S3-compatible endpoint. Requires `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME` in `.env.local` — missing
    any of them throws immediately rather than silently using local
    storage. The PDF download/view route
    ([`src/app/api/files/[fileId]/route.ts`](./src/app/api/files/[fileId]/route.ts))
    always proxies bytes through the app (streams `StorageProvider.get()`
    to the client) rather than redirecting to a presigned R2 URL, so it
    keeps re-checking the artifact's rights/publication status on every
    request — a presigned URL would stay valid for its TTL even after a
    rights change.
  - `next dev`/`build`/`start` load `.env.local` automatically; the CLI
    loads it itself (`process.loadEnvFile`) since it runs outside the
    Next.js runtime.

## Why no dual-mode (local SQLite / hosted Postgres)

Local dev now requires a live Postgres connection — there is no
`STORAGE_BACKEND`-style env-var switch back to a local/offline database.
This was a deliberate choice, not an oversight: a genuine dual-mode would
need either two divergent SQL dialects per query (`?` vs `$1`, `ON
CONFLICT`, boolean/jsonb handling all differ) or a query-builder
abstraction thick enough to become the "heavy ORM" this project explicitly
avoided elsewhere. Neon branching makes obtaining a live connection cheap
(the same credentials work for dev, and the test suite runs every write
inside a transaction that's always rolled back — see
`src/lib/db/queries.test.ts` — so it never touches real data), so the
downside of dropping the sqlite fallback is small. Run
`npm run db:migrate` once against a fresh database before `npm run dev`,
`npm run cli`, or `npm run test`.

## Not yet built

Real authentication (not needed for the CLI, but relevant if a real
multi-operator admin surface is ever built), payments, AI features, a full
acquisition/verification pipeline, OCR, duplicate detection beyond the
exact SHA-256/unique-key checks, and everything else in
`PROJECT_SPEC.md` not listed above.

## Stack

- Next.js / TypeScript (App Router) — public read-only frontend only
- A local CLI (`scripts/cli.ts`, run via `tsx`) for all admin/ingest
  operations — see spec section 11
- Postgres (Neon), via the plain `pg` client — schema in
  `migrations/0001_init.sql`, applied with `npm run db:migrate`
- Local filesystem storage or Cloudflare R2, switched via
  `STORAGE_BACKEND` (behind the `StorageProvider` abstraction)

## Getting started

```sh
npm install
cp .env.example .env.local   # fill in DATABASE_URL + DATABASE_URL_POOLED (required); R2_* optional
npm run db:migrate           # one-time: applies schema + seeds reference data
npm run dev                  # http://localhost:3000 (public site only)
npm run cli -- coverage      # admin CLI — try `npm run cli -- help` for all commands
npm run build                # production build + typecheck
npm run lint
npm run test                 # node:test via tsx --test
```

Any locally-stored uploaded files are created on first run under
`local-storage/` (gitignored, disposable). With `STORAGE_BACKEND=r2`, files
go to the configured R2 bucket instead.

## Non-goals

- No public hosting until rights are confirmed with MEHRD/schools.
- No unreleased/current exam material, ever.
- No accounts, no payments, no AI-generated exam content.
