-- SI National Exam Archive — initial schema
-- Source: PROJECT_SPEC.md section 4.2 ("Suggested relational schema").
--
-- Applied via scripts/db-migrate.ts (npm run db:migrate) — see
-- migrations/README.md for the one-time setup command. Not run
-- automatically by the app at request time.
--
-- Controlled vocabularies (which strings are valid for `type`, `status`,
-- `rights_status`, etc.) are explicitly deferred per spec section 4.3 —
-- these columns are left as plain TEXT rather than CHECK-constrained enums
-- so that vocabulary work doesn't require a schema migration.

create extension if not exists pgcrypto;

create table exam_series (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  description text
);

create table exam_instances (
  id              uuid primary key default gen_random_uuid(),
  exam_series_id  uuid not null references exam_series (id) on delete restrict,
  year            int not null,
  official_name   text,
  unique (exam_series_id, year)
);

create index idx_exam_instances_exam_series_id on exam_instances (exam_series_id);

create table subjects (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null unique,
  aliases         jsonb not null default '[]'::jsonb,
  subject_code    text
);

create table artifacts (
  id                 uuid primary key default gen_random_uuid(),
  exam_instance_id   uuid not null references exam_instances (id) on delete restrict,
  subject_id         uuid not null references subjects (id) on delete restrict,
  type               text not null,
  paper_no           text,
  title              text not null,
  status             text not null default 'draft',
  published_at       timestamptz,
  unique (exam_instance_id, subject_id, type, paper_no)
);

create index idx_artifacts_exam_instance_id on artifacts (exam_instance_id);
create index idx_artifacts_subject_id on artifacts (subject_id);
create index idx_artifacts_status on artifacts (status);

create table files (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references artifacts (id) on delete restrict,
  storage_key  text not null,
  sha256       char(64) not null,
  mime         text not null,
  bytes        bigint not null,
  pages        int,
  created_at   timestamptz not null default now()
);

create index idx_files_artifact_id on files (artifact_id);
create index idx_files_sha256 on files (sha256);

create table sources (
  id            uuid primary key default gen_random_uuid(),
  source_type   text not null,
  organization  text,
  person_label  text,
  url           text,
  attribution   text
);

create table artifact_sources (
  artifact_id  uuid not null references artifacts (id) on delete restrict,
  source_id    uuid not null references sources (id) on delete restrict,
  is_primary   boolean not null default false,
  notes        text,
  primary key (artifact_id, source_id)
);

create table verifications (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references artifacts (id) on delete restrict,
  status       text not null,
  reviewer     text,
  checked_at   timestamptz not null default now(),
  notes        text
);

create index idx_verifications_artifact_id on verifications (artifact_id);

create table rights_records (
  id             uuid primary key default gen_random_uuid(),
  artifact_id    uuid not null references artifacts (id) on delete restrict,
  rights_status  text not null,
  basis          text,
  evidence_uri   text,
  approved_by    text,
  approved_at    timestamptz,
  expiry_date    date,
  notes          text,
  -- Needed so "the most recent rights record for this artifact" (an
  -- artifact can in principle accumulate more than one over time) has a
  -- well-defined ordering. The original sqlite port used SQLite's implicit
  -- rowid for this, which has no Postgres equivalent — see PROJECT_SPEC.md
  -- decision log.
  created_at     timestamptz not null default now()
);

create index idx_rights_records_artifact_id on rights_records (artifact_id);

create table issues (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references artifacts (id) on delete restrict,
  issue_type   text not null,
  description  text not null,
  contact      text,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create index idx_issues_artifact_id on issues (artifact_id);
create index idx_issues_status on issues (status);

create table audit_events (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid,
  event_type   text not null,
  object_type  text not null,
  object_id    uuid not null,
  timestamp    timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb
);

create index idx_audit_events_object on audit_events (object_type, object_id);
create index idx_audit_events_timestamp on audit_events (timestamp);
