# SI NATIONAL EXAM ARCHIVE
### Build-ready project specification

> A free, searchable, open-source historical archive of Solomon Islands national examination papers and associated materials.

**Scope baseline:** historical examinations from 2010 onward, prioritising SIF3 / SIJSC, SISC Level 1, and SISC Level 2 / SINF6, subject to confirmation of the exact examination taxonomy for each year.

## Document purpose

This specification defines the product, data model, ingestion system, technical architecture, operational controls, legal/permission workflow, and implementation roadmap for a public Solomon Islands national examination archive. It is intentionally detailed enough to hand directly to an AI coding agent and use as the project source of truth.

**Important limitation:** this is a technical and project-planning document, not legal advice. The repository should not publish copyrighted material on the assumption that an educational exception automatically permits public online redistribution. Obtain written authorization or a defensible rights basis before publishing a hosted corpus.

## 1. Executive definition

The SI National Exam Archive (working title: SIPastPapers) will be a public digital repository for historical Solomon Islands national examination papers. Its purpose is not to create new exam content or provide access to unreleased examinations. It will preserve and make discoverable historical assessment material that is otherwise fragmented across Ministry pages, schools, teachers, former students, and document-sharing sites.

### 1.1 Product statement

```
A student should be able to open the site, select:
  Exam Level → Year → Subject → Paper
and immediately view or download the correct historical paper.
```

The archive should make the provenance and status of every file visible. A visitor must be able to tell whether a paper is officially sourced, school-sourced, community-contributed, or independently verified.

### 1.2 Core success criteria

*(to be defined)*

### 1.3 Non-goals

- No attempt to obtain or publish unreleased current examinations.
- No exam cheating service, answer-selling service, or paywalled study marketplace.
- No account requirement for ordinary users.
- No commitment to host every historically created examination before the first release.

## 2. Scope and corpus strategy

### 2.1 Initial scope

*(to be defined)*

### 2.2 Corpus acquisition tiers

*(to be defined)*

### 2.3 Canonical-source rule

A paper may have many discovered copies but only one canonical archive record. Physical files can have multiple source records and hashes. The UI should show the canonical paper while retaining the provenance trail privately for administrators and, where appropriate, publicly as a source note.

### 2.4 Recommended first release

Do not wait for 100% historical completeness. Release a coherent, explicitly labelled partial archive. A paper missing from 2014 should appear as "Not yet recovered" rather than disappear from the catalogue if the examination structure proves that the paper existed.

## 3. Product requirements

### 3.1 Public user experience

1. Homepage: search bar + three primary selectors (exam level, year, subject).
2. Results page: cards/table showing year, level, subject, artifact type, page count, verification status and actions.
3. Document page: title, metadata, provenance, preview/viewer, download button, related artifacts, report-issue link.
4. Browse page: year matrix and subject matrix for users who do not know exactly what to search. *(Built as a click-through — series → year → subject → paper — rather than a matrix view; empty series/years are flagged with a "No papers yet" badge instead of shown as grid cells. The full year × subject coverage matrix is a CLI-only view — section 11.3.)*
5. Collection page: overview of each exam family and its historical availability. *(Not built as a separate page — `/browse`'s exam-level → year → subject → paper click-through and the CLI's `coverage` matrix (section 11.3) serve this role instead.)*
6. About page: project purpose, ownership, open-source link, rights statement, correction/takedown process.
7. Admin operations: a local-only CLI (no web UI, no authentication surface) for ingest, rights approval, publication and audit logs — see section 11.

### 3.2 Search and filtering

*(to be defined)*

### 3.3 Accessibility and low-bandwidth requirements

- Fast first render on basic mobile networks.
- No heavy video or JavaScript-dependent viewer required; direct PDF download must always work.
- Use compressed thumbnails/previews; lazy-load document previews.
- All controls keyboard accessible and labelled.
- Use semantic HTML and sensible heading hierarchy.
- PDF file size should be displayed before download where known.
- Gracefully degrade to a plain browse/search experience if client-side enhancements fail.

## 4. Data model

### 4.1 Core entities

*(to be defined)*

### 4.2 Suggested relational schema

```sql
exam_series(id UUID PK, code TEXT UNIQUE, name TEXT, description TEXT)
exam_instances(id UUID PK, exam_series_id FK, year INT, official_name TEXT, UNIQUE(exam_series_id, year))
subjects(id UUID PK, canonical_name TEXT UNIQUE, aliases JSONB, subject_code TEXT)
artifacts(id UUID PK, exam_instance_id FK, subject_id FK, type TEXT, paper_no TEXT, title TEXT,
          status TEXT, published_at TIMESTAMPTZ, UNIQUE(exam_instance_id, subject_id, type, paper_no))
files(id UUID PK, artifact_id FK, storage_key TEXT, sha256 CHAR(64), mime TEXT, bytes BIGINT,
      pages INT, created_at TIMESTAMPTZ)
sources(id UUID PK, source_type TEXT, organization TEXT, person_label TEXT, url TEXT, attribution TEXT)
artifact_sources(artifact_id FK, source_id FK, is_primary BOOLEAN, notes TEXT)
verifications(id UUID PK, artifact_id FK, status TEXT, reviewer TEXT, checked_at TIMESTAMPTZ, notes TEXT)
rights_records(id UUID PK, artifact_id FK, rights_status TEXT, basis TEXT, evidence_uri TEXT,
              approved_by TEXT, approved_at TIMESTAMPTZ, expiry_date DATE, notes TEXT,
              created_at TIMESTAMPTZ)  -- added with the Postgres migration; see decision log
issues(id UUID PK, artifact_id FK, issue_type TEXT, description TEXT, contact TEXT, status TEXT,
       created_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ)
audit_events(id UUID PK, actor_id UUID, event_type TEXT, object_type TEXT, object_id UUID,
             timestamp TIMESTAMPTZ, metadata JSONB)
```

### 4.3 Controlled vocabularies

`artifacts.type`: `question_paper`, `marking_scheme`, `examiner_report`,
`listening_comprehension`, `other`. `listening_comprehension` was added
2026-09-14 to represent English listening comprehension as a distinct
artifact from the English question paper — same subject, different type,
supported without a schema change since `artifacts` was already unique on
`(exam_instance_id, subject_id, type, paper_no)`.

## 5. File and storage architecture

### 5.1 Recommended stack

Implemented as a `StorageProvider` interface (`src/lib/storage/types.ts`)
with two implementations, selected by the `STORAGE_BACKEND` environment
variable (`local` or `r2`) so callers (the CLI ingest path, the file
download/view route) never depend on which one is active:

- `local` (default) — `LocalFilesystemStorage`, writes under
  `local-storage/` on disk. No credentials, no network dependency for
  *storage* — see section 4/14.2 for why the database itself (Postgres)
  no longer has an equivalent no-network local mode.
- `r2` — `R2Storage`, Cloudflare R2. R2 exposes an S3-compatible API, so
  this is the AWS SDK's S3 client (`@aws-sdk/client-s3`) pointed at
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with an R2 API
  token as the access key pair — no R2-specific SDK needed. Configured
  via `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
  `R2_BUCKET_NAME` (`.env.example`); missing any of them throws
  immediately rather than silently falling back to local storage.

File serving (`src/app/api/files/[fileId]/route.ts`) always proxies
bytes through the app — it calls `StorageProvider.get()` and streams the
result to the client — for both backends, rather than redirecting to a
presigned R2 URL. This was a deliberate choice: the route already
re-checks the artifact's live `published` status on every request before
touching storage (section 17.1 invariant), and a presigned URL would
remain valid for its TTL even if that status changed a moment after the
URL was minted. Proxying keeps "never serve a stale cached copy" true
for R2 the same way it already was for local disk. Exam PDFs are small
enough that streaming through the app adds no meaningful latency; this
should be revisited only if file sizes or traffic volume make proxying
a bottleneck.

### 5.2 Storage layout

```
archive/{exam-series}/{year}/{subject-slug}/{artifact-type}/{canonical-file}.pdf

Example:
archive/sisc-l1/2018/mathematics/question-paper/paper-1.pdf
archive/sisc-l1/2018/mathematics/marking-scheme/paper-1.pdf
```

Do not derive file names from uncontrolled uploads. Generate deterministic names from canonical metadata. Keep the original filename in metadata for provenance.

### 5.3 File integrity

- Calculate SHA-256 at ingest.
- Reject unsupported or obviously corrupt files.
- Persist original file bytes; do not silently overwrite an asset.
- On replacement, create a new FileAsset/version and retain the previous hash.
- Run periodic integrity checks against stored hashes.
- Detect exact duplicates across sources using hashes before creating new canonical artifacts.

### 5.4 PDF handling

Treat the original PDF as the authoritative asset. Optional derivatives include a web preview, page thumbnails, extracted text and OCR text. Never replace the original with an OCR-derived or recompressed copy without retaining the original.

## 6. Ingestion pipeline

### 6.1 End-to-end workflow

```
DISCOVER → ACQUIRE → VIRUS/CORRUPT CHECK → HASH → EXTRACT METADATA →
MATCH / DEDUPLICATE → HUMAN VERIFY → RIGHTS CHECK → PUBLISH → INDEX → AUDIT
```

### 6.2 Ingestion states

*(to be defined)*

### 6.3 Metadata validation rules

- Year must be a valid four-digit year within configured historical boundaries.
- Exam series and subject must use canonical IDs, not free-text variants.
- Paper number may be "1", "2", "A", "B", or "—" depending on official structure; preserve the printed identifier in addition to normalized fields.
- Title must be generated consistently from canonical metadata unless the source title is materially informative.
- Page count must match the file when technically detectable.
- A paper with a suspected year manipulation or mismatch is quarantined, not published.
- Rights status must be resolved before PUBLIC status.

### 6.4 Duplicate detection

```
1. SHA-256 exact match → same physical file.
2. Same exam/year/subject/type/paper_no → candidate logical duplicate.
3. If hashes differ, compare page count + extracted text similarity + visual spot checks.
4. Preserve multiple provenance sources when they represent the same logical paper.
```

### 6.5 OCR

OCR is optional and should be applied selectively to scanned documents. Store OCR as derivative text; never treat OCR output as the source of truth. The archive should support text search even where OCR is imperfect by clearly labelling it as machine-extracted.

## 7. Verification and quality assurance

### 7.1 Verification checklist per paper

1. Confirm printed year and examination name.
2. Confirm subject and paper identifier.
3. Confirm page sequence and total page count.
4. Check that the first/last page is not missing.
5. Check whether pages have been reordered, cropped, watermarked, or altered.
6. Compare against a second source when the paper originated outside MEHRD/NEAD.
7. Check that the file opens, renders and downloads correctly.
8. Record source provenance and verification notes.
9. Resolve or explicitly flag any contradiction before publication.
10. Confirm the rights/permission state is compatible with public hosting.

### 7.2 Suspicious-paper handling

Because examination papers have historically circulated with manipulated years or labels, suspicious material must be treated as an archival verification problem. Examples include a paper whose content exactly matches a known older paper but whose cover says a newer year, a paper lacking expected official identifiers, or a paper whose subject does not match the official timetable.

### 7.3 Release QA

- Broken-link test across all public artifacts.
- PDF smoke test for each new upload.
- Metadata uniqueness check.
- No PUBLIC record with unresolved rights state.
- No missing required metadata fields.
- No admin route exists in the deployed web app at all — admin operations run only through the local CLI (section 11), never over HTTP.
- No secrets committed to Git.
- Automated build, lint and typecheck pass before deployment.

## 8. Rights, permissions and institutional engagement

### 8.1 Recommended order of approach

*(to be defined)*

### 8.2 Permission request objectives

The preferred outcome is a short written authorization covering historical examination papers and associated assessment documents for free, non-commercial public educational access. Ask for permission to reproduce, host, make available for download, index and preserve the material. Ask whether attribution wording, takedown procedures, or year limitations should apply.

### 8.3 Suggested rights-record structure

```yaml
rights_status: permission_granted
basis: written authorization
authorized_by: <name/title>
evidence_uri: <internal document reference>
approved_at: YYYY-MM-DD
expiry_date: null
conditions: <attribution / non-commercial / other>
```

### 8.4 Public rights notice

The site should identify the rights holder where known, state that the archive is independent unless formally adopted by MEHRD, provide a source/attribution note, and expose a simple rights/correction contact. Do not imply Ministry endorsement unless the Ministry has explicitly granted it.

### 8.5 Takedown and correction policy

1. Receive the report and identify the affected artifact.
2. Place the artifact on RIGHTS_HOLD when the claim plausibly concerns ownership, privacy, security, or authenticity.
3. Review provenance and rights evidence; contact the relevant rights holder when needed.
4. Resolve to retain, correct, replace, restrict, or withdraw.
5. Log the final decision, evidence and date.

## 9. Security model

### 9.1 Threat model

*(to be defined)*

### 9.2 Critical security principle

The system must never be designed to obtain, infer, or expose unreleased examinations. The acquisition subsystem should explicitly reject operational/current exam material and maintain an allowlist of historical years that are eligible for ingestion.

### 9.3 Admin roles

**N/A for now.** Admin operations run only through the local CLI (section
11), used by a single local operator (the project owner) on one machine —
there is no multi-user admin surface, no accounts, and therefore no role
separation to define yet (e.g. "ingest operator" vs. "rights approver" vs.
"publisher" are all the same person running the same CLI today). Revisit
this once either (a) more than one person needs to run admin operations,
or (b) a real MEHRD/institutional approval process exists and its
participants need distinct, auditable roles rather than a name typed into
`--approved-by` (see the caveat in section 11.2).

## 10. Repository architecture

### 10.1 Git repository structure

```
si-national-exam-archive/
├─ apps/{web,admin}/
├─ packages/{db,validation,search,ui}/
├─ scripts/{ingest,verify,dedupe,ocr,audits}/
├─ data/{seed,manifests}
├─ docs/{project-spec,data-dictionary,ingestion,verification,rights,contributing}
└─ .github/workflows/{ci,release}
```

### 10.2 CI/CD

- Pull request: lint, typecheck, unit tests, build, schema validation.
- Protected main branch; merge through reviewed pull request.
- Deploy preview on pull request.
- Production deploy only from main or tagged release.
- Run migration step separately and safely.
- Post-deploy smoke tests: homepage, search, one sample document, storage access.

### 10.3 Environment separation

```
local → development → staging → production
```

Production database and storage credentials must never be used locally. Sample/test PDFs should be synthetic or known-safe fixtures rather than a copy of the production archive.

## 11. Admin interface specification

Admin operations are exposed only as a local CLI (`npm run cli -- <command>`,
implemented in `scripts/cli.ts`), never as a web UI or HTTP route. It runs
locally, connecting straight to Postgres and whichever storage backend is
configured, so it carries no authentication of its own — the same way any
other local developer script would run. There is no `/admin/*` surface in
the deployed app at all.

### 11.1 Commands

```
ingest <file> --series <code> --year <yyyy> --subject <slug>
    [--type <artifact-type>] [--paper-no <no>]
    [--source <org>] [--source-url <url>] [--attribution <text>]
    [--dry-run]

    Hashes the file (SHA-256), writes it to storage under the canonical
    key (section 5.2), inserts the artifact and file record, and always
    creates a rights_records row pinned to
    rights_status = 'pending_institutional_approval' with basis,
    approved_by and evidence_uri left null. The operator running ingest
    cannot set those fields directly — see approve-rights below.

ingest <directory> --series <code> --year <yyyy> --subject <slug>
    [--source <org>] [--source-url <url>] [--attribution <text>]
    [--dry-run]

    Batch mode: one directory maps to one exam-instance/subject (fixed
    series/year/subject for every file). Each file's artifact type and
    paper number are inferred from its own filename using the convention
    <artifact-type-slug>_<paper-no>.pdf (paper-no segment omitted when
    not applicable), e.g. question-paper_1.pdf, marking-scheme_1.pdf,
    examiner-report.pdf. Files that don't match are skipped with a
    warning; a failure on one file (e.g. a duplicate, or an invalid PDF)
    does not abort the rest of the batch.

    --dry-run (either form) makes no database or storage changes. It
    prints a table of every file with its inferred artifact type and
    paper number, or why it couldn't be parsed / isn't a readable PDF,
    plus a parseable/flagged count. Intended to be run against a real
    batch directory before the real (non-dry-run) ingest, since a bad
    filename convention or a corrupt scan is much cheaper to catch here
    than partway through hundreds of real files.

approve-rights <artifact-id> --basis <basis-value> --approved-by <name>
    --evidence-uri <uri>
    [--rights-status permission_granted|public_domain_or_expired]
    [--expiry <yyyy-mm-dd>] [--notes <text>]

    Records the institutional rights decision on the artifact's rights
    record. This is the only way basis/approved_by/evidence_uri get
    filled in. --basis and --approved-by have specific, non-obvious
    semantics documented in section 11.2 — read that before using this
    command for real ingested material.

approve-rights --series <code> --year-range <yyyy-yyyy> --basis <basis-value>
    --approved-by <name> --evidence-uri <uri>
    [--rights-status permission_granted|public_domain_or_expired]
    [--expiry <yyyy-mm-dd>] [--notes <text>] [--confirm]

    Bulk form, added 2026-09-14. Applies the same basis/approved_by/
    evidence_uri/etc. to every artifact matching the series and year
    range that doesn't already have rights approved. Without --confirm,
    prints the list of matching artifact IDs and titles and makes no
    changes (dry-run by default, same pattern as ingest's --dry-run).
    Mutually exclusive with a positional <artifact-id> — mixing the two
    is an error.

publish <artifact-id>

    The only place artifact status is ever set to "published". Refuses
    and prints exactly which of basis / approved_by / evidence_uri is
    still missing on the artifact's rights record, rather than
    publishing — see section 6.3 and the invariant in section 17.1. This
    is a safeguard the old admin web UI did not have: previously,
    clicking "publish" silently force-set the rights record itself.

publish --series <code> --year-range <yyyy-yyyy> [--confirm]

    Bulk form, added 2026-09-14. Publishes every matching artifact whose
    rights are already approved, skipping (with a stated reason) any
    that aren't. Same dry-run-by-default/--confirm gating as bulk
    approve-rights.

unpublish <artifact-id> [--status withdrawn|rights_hold] [--reason <text>]

    Flips a published artifact back to a non-public status and logs the
    action. New command — publishing was previously one-directional.

list

    Lists every artifact with its id, status and rights status (there is
    no other way to discover an artifact's id from the CLI).

coverage

    Prints the year x subject coverage matrix described in 11.2 below.
```

Every ingest, rights approval, publish and unpublish action is logged to
`audit_events` (section 4.2), matching the original admin UI's behavior.

### 11.2 Rights basis vocabulary and approved-by semantics

`--basis` on `approve-rights` is a fixed enum, not free text, validated by
the CLI (an invalid value is refused with the list of valid choices):

| Value                       | Meaning |
|------------------------------|---------|
| `teacher-verified`           | Verified via a personal network of teachers, education officers, or former students who confirmed the paper's authenticity/provenance. **This is the primary verification path currently in use** — most real ingests will use this value, not `institutional-submission`. |
| `personal-collection`        | From the operator's own personal archive/collection, with no separate third-party verification step. |
| `institutional-submission`   | Directly submitted or authorized by an institution (e.g. MEHRD, a school) acting as the rights holder or an authorized source. |
| `other`                      | Any other basis not covered above — use `--notes` to explain. |

**`--approved-by` does not mean institutional sign-off.** As of this
writing, MEHRD has not been approached about this project, so
`approved_by` is filled in with the name of whoever is personally doing
the verification (e.g. the project operator), not an authorized Ministry
representative. Nothing in the schema or the CLI currently distinguishes
"a person vouching for a paper" from "an institution formally approving
it" — a filled-in `rights_records` row must not be read or presented as
MEHRD/NEAD endorsement (see section 8.4's rule against implying Ministry
endorsement without an explicit grant). **This should be revisited** once
a real MEHRD rights conversation happens (section 8.1) and an actual
institutional approval process exists — at that point `approved_by`
should be constrained to identify a real institutional approver (and
`--basis institutional-submission` should require it), rather than
accepting any name.

### 11.3 Coverage matrix

Every expected year/subject combination is represented as a state
(published, rights pending, missing, or not yet recovered), printed as a
text matrix per exam series by the `coverage` command, so the state of the
archive is visible without a web UI.

## 12. Public information architecture

### 12.1 URL strategy

As built, browsing and the final document page are two separate route
trees rather than one nested hierarchy under `/exams`:

```
/
/browse
/browse/sisc-l1
/browse/sisc-l1/2018
/browse/sisc-l1/2018/mathematics
/exams/sisc-l1/2018/mathematics/paper-1
/exams/sisc-l1/2018/mathematics/marking-scheme
```

`/exams/{series}/{year}/{subject}/{artifact}` is the document page — a
single leaf segment (a slug like `paper-1` or `marking-scheme`, derived
from the artifact's type/paper number, not a nested sub-path), reached
by clicking through `/browse`, not by a `/exams` index or intermediate
`/exams/...` listing pages. A marking scheme is its own sibling artifact
page, not a suffix on the question paper's URL.

Stable URLs matter. Do not encode internal database UUIDs into the public URL unless necessary. Use human-readable slugs with redirects if taxonomy changes.

### 12.2 SEO and discoverability

- Each public paper has a unique title and metadata description.
- Generate sitemap entries for public artifact pages.
- Use canonical URLs.
- Permit search-engine indexing of public historical pages.
- Block indexing of admin, draft and rights-hold pages.
- Use descriptive filenames and metadata for PDFs where appropriate.

### 12.3 Paper page layout

1. Paper title and year.
2. Breadcrumb: Exam level → year → subject.
3. Badges: Verified / source / rights status where public.
4. View PDF.
5. Download PDF.
6. Paper metadata table.
7. Related marking scheme / report.
8. Source and attribution.
9. Report a problem.

## 13. Collection and recovery programme

### 13.1 Acquisition workflow

1. Create a coverage matrix from authoritative exam structures.
2. Search the current MEHRD/NEAD ecosystem for each missing item.
3. Approach schools, teachers, former students and libraries for historical gaps.
4. Accept contributions through a controlled upload process.
5. Normalize and hash every file.
6. Verify identity and integrity.
7. Resolve rights.
8. Publish and record provenance.

### 13.2 Contributor submission form

```
Year: [required]
Exam level: [required]
Subject: [required]
Paper: [optional]
What is this file? [paper / marking scheme / report / other]
Where did you get it? [free text]
School/institution (optional): [text]
Can we contact you? [email optional]
Upload: [PDF]
```

Contributor data should be minimized. Do not publish contributor contact details without explicit consent.

### 13.3 Source priority

When two copies differ, prefer the copy with stronger institutional provenance. A cleanly scanned school copy can be preferable to a low-quality repost even if both appear identical. Preserve both provenance references in the internal source table when useful.

### 13.4 Naming convention

```
<exam-series>_<year>_<subject>_<artifact-type>_<paper-no>.pdf

Examples:
sisc-l1_2018_mathematics_question-paper_1.pdf
sisc-l1_2018_mathematics_marking-scheme_1.pdf
```

## 14. Project governance

### 14.1 Ownership

The project owner should control the GitHub organization/repository, primary domain, production hosting, database, object storage, backups and DNS. Do not build the service under a developer's personal account.

### 14.2 Decision log

- **2026-09-12 — Removed the admin web UI in favor of a local CLI.**
  `/admin/*` (artifact form, artifact list, coverage matrix) and the HTTP
  Basic Auth gate in `src/proxy.ts` were removed entirely and replaced
  with `scripts/cli.ts` (`npm run cli -- <command>`, section 11). Reason:
  the web admin surface added an authentication problem (a single shared
  password gate, explicitly documented as a placeholder, not a real auth
  system) for a feature that only one local operator uses, from one
  machine, against a local SQLite database and local filesystem storage.
  A local script needs no authentication of its own because it never
  listens on a network port; removing the web surface removed that
  problem instead of solving it. The deployed app now serves only the
  public read-only pages.
- **2026-09-12 — Added the rights-basis publish gate.** `publish` now
  refuses (printing exactly what's missing) unless the artifact's rights
  record already has `basis`, `approved_by` and `evidence_uri` all set via
  the new `approve-rights` command — the old admin UI's "publish" button
  force-filled these itself, which meant nothing actually verified that a
  rights decision had been made before something went public. This is a
  stricter reading of section 6.3 ("Rights status must be resolved before
  PUBLIC status") than the original admin UI implemented.
- **2026-09-12 — `--basis` is a fixed enum, not free text**, and
  `teacher-verified` is the primary value in current use. Reason: real
  verification right now happens through the project owner's personal
  network of teachers, education officers and former students — not
  through MEHRD or another institution — and the vocabulary needed to say
  that precisely, rather than let `basis` become an inconsistent free-text
  field across ingests. See section 11.2 for the full vocabulary and the
  related caveat about `--approved-by` not implying institutional
  sign-off.
- **2026-09-12 — Batch ingest resilience fix.** The original batch loop
  read each file through a helper that called `process.exit()` on an
  invalid PDF, which meant one corrupt scan partway through a large
  directory would silently kill the entire batch run without processing
  the remaining files. Fixed so a bad file is classified, logged, and
  counted as failed while the rest of the batch continues — verified with
  the test suite (section 17) and manually before running against real
  multi-year F3 material. `--dry-run` was added to `ingest` at the same
  time so a batch directory's filenames and file integrity can be checked
  up front, before any database or storage writes happen.
- **2026-09-13 — Added Cloudflare R2 as a second storage backend**,
  switched via `STORAGE_BACKEND=local|r2` (section 5.1), behind the same
  `StorageProvider` interface used since Phase 1 — no changes to the CLI
  ingest flags or to `queries.ts`'s ingest logic, which already only
  depended on the interface. File serving continues to proxy bytes
  through the app for both backends rather than issuing presigned URLs,
  to preserve the existing "re-check rights on every request" guarantee
  (see section 5.1 for the full rationale).
- **2026-09-13 — Migrated the database from local SQLite to Postgres
  (Neon), with no dual-mode fallback.** `src/lib/db/client.ts` now wraps
  `pg` (a `Pool` against `DATABASE_URL_POOLED` for app/CLI runtime queries;
  `scripts/db-migrate.ts` uses the unpooled `DATABASE_URL` for schema
  migrations + reference-data seeding, run explicitly via
  `npm run db:migrate` rather than automatically at app startup — see
  section 4.2, migrations/README.md). `node:sqlite`,
  `migrations/sqlite/0001_init.sql` and `src/lib/db/migrate.ts` were
  deleted; `migrations/0001_init.sql` (the Postgres schema, previously
  unapplied) is now the only schema and has been applied to the real
  database. A true dual-mode (SQLite for offline dev, Postgres for
  production) was considered and rejected: the two engines differ enough
  at the query level (`?` vs `$n` placeholders, jsonb auto-parsed by the
  Postgres driver vs manual `JSON.parse`/`stringify` on a sqlite TEXT
  column, integer 0/1 vs real `boolean`, and SQLite's implicit `rowid` —
  used to order "most recent rights record" — having no Postgres
  equivalent) that supporting both would have meant either two parallel
  SQL dialects per query or a query-builder abstraction thick enough to
  become the "heavy ORM" explicitly avoided elsewhere in this project.
  Fallout from that difference: `rights_records` gained a `created_at`
  column (default `now()`) purely to replace the old `rowid`-based
  ordering. Local dev and the test suite now require a live Postgres
  connection — mitigated by Neon branching making that connection cheap
  to obtain, and by the test suite wrapping every test in a transaction
  that's always rolled back (`withRolledBackTransaction`,
  `src/lib/db/client.ts`) so it can run directly against the real database
  without leaving data behind. All of `queries.ts` is now `async`
  (`node:sqlite`'s `DatabaseSync` was synchronous); every caller (CLI
  commands, page components, the file-download route) was updated to
  `await` it.
- **2026-09-14 — Added `listening_comprehension` as an artifact type**,
  under the existing `english` subject rather than as a new subject.
  Reason: exam officials treat English question papers and listening
  comprehension as two separate physical documents, but they're the same
  subject — `type` already existed as the axis to distinguish them, so
  this needed no schema change, only extending the CLI's `--type` enum
  and `ArtifactType` union (see 4.3).
- **2026-09-14 — Bulk `approve-rights`/`publish` by `--series`/
  `--year-range`.** Added because the first real content batch (40
  artifacts: F3 2016–2023, all 4 subjects) all shared one verification
  basis and approver, and the single-artifact commands would have meant
  80+ manual invocations. Dry-run by default, gated behind `--confirm`,
  same pattern as ingest's `--dry-run`. Single-artifact usage is
  unchanged and the two modes are mutually exclusive (see 11.1).
- **2026-09-14 — Postgres connection retry/timeout split by context.**
  `src/lib/db/client.ts`'s retry logic (added when a transient
  `ECONNRESET`/connection-timeout was traced to network-level TLS
  interception on one operator network, not a code or credentials bug)
  now uses a different budget depending on a `DB_POOL_PROFILE` env var:
  `web` (default, zero config needed) fails fast — 5s timeout, 1 attempt
  — since a real site visitor shouldn't wait through a multi-attempt
  retry only to potentially be cut off by a serverless function timeout
  anyway; `cli` (set explicitly by `scripts/cli.ts` and the test suite)
  keeps the more patient 15s timeout / 3-attempt-with-backoff behavior
  appropriate for an operator running commands directly. Retries remain
  scoped to transient connection-level errors only (never query-level
  errors, and never a query already running inside an open transaction,
  since retrying that could land on a different connection mid-
  transaction).
- **2026-09-14 — `createIssue` excluded from connection retry.** It's a
  non-transactional INSERT with no natural unique constraint on `issues`
  to dedupe on (two people can legitimately report the same problem), so
  retrying it risked a silent duplicate row if a connection reset
  between the insert being sent and its ack returning. Now uses a new
  `queryWithoutRetry` export (`src/lib/db/client.ts`) and fails once
  rather than risking that — not yet exercised in production since the
  issue-intake UI/API (section 8.5) doesn't exist yet.
- **2026-09-14 — First real content ingested and published:** F3
  (SIF3/SIJSC), 2016–2023, all 4 subjects, 40 artifacts total (32
  question papers + 8 English listening comprehension papers). Rights
  basis: `teacher-verified` for all 40 — personal network of SI teachers,
  education officers and former students, not an institutional/MEHRD
  approval (see 11.2's caveat on `--approved-by`). Marking schemes not
  ingested as part of this batch (see 2026-09-21 entry below for the
  current policy). 2015, 2024, and 2025 not yet ingested (papers not yet
  acquired for those years).
- **2026-09-21 — Marking-scheme ingestion now permitted, superseding
  the 2026-09-14 decision above.** That decision held marking schemes
  back because a scheme's phrasing might no longer reliably match how a
  repeated question is taught today. The verification concern is
  resolved for the SISC L1 (Year 11) and L2/SINF6 (Year 12) marking
  schemes now being organized for ingest — they are newly-verified.
  Marking schemes for other series/years remain subject to the same
  verification bar before ingestion.

### 14.3 Documentation set

- `PROJECT_SPEC.md` — this document converted to repository form.
- `DATA_DICTIONARY.md` — fields, types and controlled vocabularies.
- `INGESTION.md` — operator workflow.
- `VERIFICATION.md` — authenticity and QA rules.
- `RIGHTS_POLICY.md` — permission, attribution, takedown and restrictions.
- `CONTRIBUTING.md` — developer and archive contributor instructions.
- `RUNBOOK.md` — backup, restore, deployment and incident procedures.
- `CHANGELOG.md` — release history.

## 15. Roadmap

### Phase 0 — permission + reconnaissance
### Phase 1 — MVP shell
### Phase 2 — 2010–2024 corpus build
### Phase 3 — search + preservation

- Full-text/OCR search where useful.
- Improved metadata aliases and subject normalization.
- Automated integrity/link checks.
- Public contribution workflow.
- Backup and disaster-recovery drills.

### Phase 4 — institutionalization

- Offer MEHRD/NEAD a maintained mirror or official adoption path.
- Publish annual archive updates after historical status is safe to release.
- Formalize contribution agreements with schools and institutions.
- Explore public educational-resource licensing if MEHRD wishes to adopt one.

## 16. Backups, preservation and disaster recovery

### 16.1 Minimum backup policy

*(to be defined)*

### 16.2 Recovery objectives

*(to be defined)*

### 16.3 Preservation principle

The website is an interface; the archive is the underlying corpus. Design for migration. You should be able to export the full metadata database and all PDF assets without relying on the continued existence of one hosting provider.

## 17. Testing strategy

### 17.1 Critical invariant tests

```
assert(public_artifact.rights_status in {permission_granted, public_domain_or_expired})
assert(public_artifact.status == published)
assert(public_artifact.file.sha256 is not null)
assert(public_artifact.exam_year <= archive.max_public_historical_year)
assert(unique(exam, year, subject, type, paper_no))
assert(no_public_link_points_to_missing_object_storage_key)
```

## 18. Observability and operations

- Error monitoring for frontend/backend failures.
- Logging for ingestion, publication and withdrawal actions.
- Alert on repeated storage failures, failed scheduled integrity checks, or database errors.
- Health endpoint for application and dependent-service reachability.
- Dashboard for public corpus count and coverage progression.
- No logging of passwords, access tokens, or unnecessary contributor personal data.

### 18.1 Operational runbook

1. Check service status and hosting logs.
2. Check database health.
3. Check object storage availability.
4. Check recent deployment/change log.
5. Roll back application if the latest release caused regression.
6. Restore data only after confirming corruption and the recovery point.
7. Document incident and resolution.

## 19. Analytics and impact metrics

Avoid collecting student names, school identifiers, phone numbers, precise location, or other personal data unless there is a specific operational requirement.

## 20. Launch checklist

1. NEAD / rights conversation initiated and documented.
2. Project repository and owner-controlled infrastructure established.
3. 2010–2024 coverage matrix created.
4. Core taxonomy validated against authoritative material.
5. Database migrations committed.
6. Object storage bucket secured and versioned.
7. Production database and storage credentials restricted to trusted operators running the admin CLI (section 11) — there is no separate admin authentication surface to configure by design.
8. Rights gate implemented.
9. At least one test paper ingested end-to-end.
10. At least one complete year/subject slice verified.
11. Correction/takedown process documented.
12. Privacy and terms pages published.
13. Backup restore tested.
14. CI/CD passing.
15. Accessibility and mobile QA completed.
16. Production smoke test completed.
17. Public launch begins with clearly labelled corpus coverage and gaps.

## 21. Suggested open-source policy

Use a permissive software license such as MIT or Apache-2.0 for the codebase unless another institutional requirement exists. Separately document the licensing/rights status of archived examination documents. The software license must never be interpreted as granting rights in third-party or Government-owned examination content.

### 21.1 Repository contribution rules

- Contributors must describe the source of uploaded papers.
- Never upload unreleased or confidential examination material.
- Never include passwords, internal government credentials, or private student data.
- Contributors should flag uncertainty rather than editing a paper to "make it look right."
- Archive maintainers may reject material with unresolved authenticity or rights concerns.

## 22. Immediate implementation backlog

*(to be defined)*

## 23. Working principles for Claude Code

- Treat this specification as the product contract; do not invent requirements that increase complexity without a reason.
- Prefer simple, boring architecture over premature microservices.
- Keep metadata normalized and human-auditable.
- Every destructive or rights-sensitive action must be reversible or logged.
- Never silently replace historical files.
- Use migrations for schema changes; never hand-edit production tables as a routine workflow.
- Write tests for state transitions and invariants before adding convenience features.
- Optimize for mobile/low-bandwidth users in Solomon Islands.
- Keep the public site usable without JavaScript-dependent document viewing.
- Never add user accounts unless a concrete requirement emerges.
- Never add monetization that conflicts with the free-access mission.
- Keep the data portable and exportable at all times.

### 23.1 First Claude Code prompt

```
Read PROJECT_SPEC.md completely before modifying the repository.
Build Phase 1 only:
1. Scaffold the Next.js/TypeScript application.
2. Add PostgreSQL schema and migrations for exam_series, exam_instances, subjects,
   artifacts, files, sources, artifact_sources, verifications, rights_records,
   issues, and audit_events.
3. Add seed data interfaces but do not invent historical exam data.
4. Implement public browse/search pages with empty-state handling.
5. Implement protected admin ingest flow.
6. Implement SHA-256 hashing and exact duplicate detection.
7. Implement the rights-state publication gate.
8. Add tests for all P0 invariants.
9. Add README, CONTRIBUTING.md, RIGHTS_POLICY.md and DATA_DICTIONARY.md.
10. Keep file storage behind an abstraction so the provider can be changed later.

Do not add authentication for public users. Do not add payments. Do not add AI features.
Do not ingest or generate exam papers. Do not publish any document until its rights state
permits publication.
```

## 24. Research basis and reference links

The project rationale and scope were informed by the current public web landscape checked in September 2026. The following links are reference points rather than guarantees that their current files remain available.

**Note on source quality:** third-party document-sharing pages were used as evidence that historical papers are distributed online, not as preferred authoritative sources. The archive should prioritize original MEHRD/NEAD, school or institutionally held copies whenever possible.

## Appendix A — Example public metadata record

```json
{
  "id": "uuid",
  "exam_series": "SISC Level 1",
  "year": 2018,
  "subject": "Mathematics",
  "artifact_type": "question_paper",
  "paper_number": "1",
  "title": "SISC Level 1 Mathematics 2018 — Paper 1",
  "status": "published",
  "verification": "independently_verified",
  "rights": "permission_granted",
  "file": {
    "sha256": "...",
    "mime": "application/pdf",
    "pages": 24,
    "bytes": 1234567
  },
  "source": {
    "type": "mehrd",
    "organization": "Ministry of Education and Human Resource Development",
    "attribution": "Used with permission / per documented rights basis"
  }
}
```

## Appendix B — Definition of done for the archive

1. The site has a stable public domain and project-owned infrastructure.
2. Every public document is linked to an internal artifact ID and a stored file hash.
3. Every public document has a recorded rights basis.
4. Users can search by exam level, year and subject without logging in.
5. Administrators can ingest and verify files without direct database manipulation.
6. The coverage matrix exposes both availability and known gaps.
7. Duplicate files are detected and provenance is preserved.
8. Backups have been restored successfully in a test.
9. The project can export its metadata and files for migration.
10. The project can operate independently of any one individual contributor.
11. The initial corpus is clearly labelled as a historical archive and does not contain unreleased material.
