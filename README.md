# SIPastPapers

A searchable archive of historical Solomon Islands national examination
papers (SIF3/SIJSC otherwise known as Year 9, SISC Level 1 otherwise known
as Year 11, SISC Level 2/SINF6 otherwise known as Year 12), built for
public use.

**Status:** Phase 3 — live at
[sipastexams.com](https://sipastexams.com), with 291
published papers across all three exam levels. Next.js app backed by a
real Postgres (Neon) database and file storage (local filesystem by
default for dev, Cloudflare R2 in production — see "What's implemented"
below). No authentication — no accounts, and no admin HTTP surface (admin
is a local-only CLI; see "Admin" below).

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
  - `/results` — filtered, paginated results table (published artifacts
    only). The search box understands years ("2018"), exam levels
    however they're written ("Year 11", "Form 5", "SISC L1") and short
    subject names ("maths"); every other word must match
    (`src/lib/search-query.ts`).
  - `/browse` — click-through by exam level → year → subject → paper
    (`/browse` → `/browse/[series]` → `/browse/[series]/[year]` →
    `/browse/[series]/[year]/[subject]`); a series or year with nothing
    published yet is shown with a "No papers yet" badge rather than
    hidden. (The full year × subject coverage matrix is a CLI-only view —
    see `coverage` under "Admin" below.)
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
    what `--approved-by` does (and doesn't) mean right now. Also has a
    bulk form, `approve-rights --series <code> --year-range <yyyy-yyyy>
    ... [--confirm]`, for approving every matching unapproved artifact at
    once (dry-run unless `--confirm` is passed).
  - `publish <artifact-id>` — the only place status becomes `published`.
    Refuses, printing exactly what's missing, unless the rights record
    already has basis, approved_by and evidence_uri set. This safeguard
    didn't exist in the old admin web UI. Also has a bulk form, `publish
    --series <code> --year-range <yyyy-yyyy> [--confirm]`, which publishes
    every matching artifact whose rights are already approved and skips
    (with a stated reason) any that aren't.
  - `unpublish <artifact-id>` — takes a published artifact back off the
    public site, and moves its stored file to a `quarantine/` key so any
    download link already handed out stops working immediately (nothing
    under `quarantine/` is ever served). `publish` moves it back.
    `unpublish <artifact-id> --purge` lists what would be permanently
    deleted from quarantine; add `--confirm` to delete it (audit-logged).
    Unpublishing also deletes that year's "Download all" zips.
  - `build-zips (--series <code> --year <yyyy> | --all) [--confirm]` —
    builds each year's "Download all" zip from the papers servable right
    now and stores it in R2 (the website never builds zips; until a
    year's zip is built it answers "not ready yet"). `publish` and
    `unpublish` print the exact command when a year needs rebuilding.
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
    re-checks the paper's publication and rights status on every request,
    applies the rate limit, then redirects (302) to a presigned
    R2 URL valid for 10 minutes — so PDF bytes never pass through the app.
    A paper that's unpublished stops being handed out at once; a link
    handed out just before stays valid until it expires (accepted, see
    PROJECT_SPEC section 5.1). With local storage the route streams the
    file itself instead.
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
avoided elsewhere. Neon branching makes obtaining a live connection cheap,
so the downside of dropping the sqlite fallback is small. Run
`npm run db:migrate` once against a fresh database before `npm run dev`
or `npm run cli`.

The test suite never uses `.env.local`'s database. It connects to a
separate Neon **branch** whose pooled connection string goes in
`.env.test.local` (gitignored) as `DATABASE_URL_POOLED`, and refuses to
run if that file is missing or points at the same database endpoint as
`.env.local` (`src/lib/db/test-database-env.ts`). Every test write also
runs inside a transaction that's always rolled back.

## Stack

- Next.js / TypeScript (App Router) — public frontend; the only write path
  is the "report a problem" form on each paper page (`reportIssueAction`
  in `src/app/exams/[series]/[year]/[subject]/[artifact]/actions.ts`),
  which inserts an `issues` row
- A local CLI (`scripts/cli.ts`, run via `tsx`) for all admin/ingest
  operations — see spec section 11
- Postgres (Neon), via the plain `pg` client — schema in
  `migrations/0001_init.sql`, applied with `npm run db:migrate`
- Local filesystem storage or Cloudflare R2, switched via
  `STORAGE_BACKEND` (behind the `StorageProvider` abstraction)
- Hosted on Vercel. [`vercel.json`](./vercel.json) pins server functions
  to `syd1` (Sydney), next to the Neon database (`ap-southeast-2`) and the
  closest Vercel region to Solomon Islands visitors — Vercel's default
  (`iad1`, Washington DC) put every database query across the Pacific

## Getting started

```sh
npm install
cp .env.example .env.local   # fill in DATABASE_URL + DATABASE_URL_POOLED (required); R2_* optional
npm run db:migrate           # one-time: applies schema + seeds reference data
npm run dev                  # http://localhost:3000 (public site only)
npm run cli -- coverage      # admin CLI — try `npm run cli -- help` for all commands
npm run build                # production build + typecheck
npm run lint
npm run test                 # node:test via tsx --test; needs .env.test.local (Neon branch), see above
```

Any locally-stored uploaded files are created on first run under
`local-storage/` (gitignored, disposable). With `STORAGE_BACKEND=r2`, files
go to the configured R2 bucket instead.

## Environment variables: Vercel vs. CLI-only

The website never writes to R2: it only reads (and hands out short-lived
download links). Give Vercel — Production **and** Preview — an R2 API
token with **read-only** object access. The token that can write
(ingest, unpublish, purge, set-disposition) stays in your local
`.env.local` for the CLI only.

| Variable | Vercel (Production / Preview) | Notes |
|---|---|---|
| `DATABASE_URL_POOLED` | Required | Build and runtime. Preview should use a Neon **branch**, not production: the report form is the one thing the site writes, and it writes here. |
| `STORAGE_BACKEND=r2` | Required | Without it the site looks for files on local disk, which Vercel doesn't have. |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` | Required | |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Required — **read-only token** | |
| `RATE_LIMIT_SECRET` | Recommended | Any long random string; without it each running copy signs visitor cookies with its own key. |
| `NEXT_PUBLIC_SITE_URL` | Optional | Defaults to `https://sipastexams.com`. |
| `RATE_LIMIT_*` overrides | Optional | See `.env.example`. |
| `PAGE_PATHS_REFRESH_SECONDS` | Optional | How often `src/proxy.ts` reloads the list of real page addresses (default 300). |
| `DATABASE_URL` | CLI only | Direct connection, for `npm run db:migrate`. |
| `DB_POOL_PROFILE`, `SIPASTPAPERS_STORAGE_ROOT` | CLI / local only | |

`VERCEL_REGION` is set by Vercel itself. Building the site runs no
migrations and writes nothing.

## License

Code is MIT-licensed — see [`LICENSE`](./LICENSE). This covers the
codebase only, not rights to the archived exam content itself, which is
tracked separately per-artifact (see `rights_records` in
[`PROJECT_SPEC.md`](./PROJECT_SPEC.md) section 4.2 and the correction
process on the `/about` page).

## Non-goals

- No implying MEHRD/institutional endorsement of hosted material unless
  explicitly granted — publication currently proceeds under a documented,
  non-institutional rights basis (mainly `teacher-verified`; see
  `PROJECT_SPEC.md` section 11.2), not confirmed MEHRD permission.
- No unreleased/current exam material, ever.
- No accounts, no payments, no AI-generated exam content.
