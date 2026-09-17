-- This file sets up the database tables for the SI National Exam Archive.
-- Think of it as the "blueprint" for how exam data is stored and organized.
--
-- You don't need to run this file yourself when the app starts — it's
-- applied once, ahead of time, using the "npm run db:migrate" command.
-- See migrations/README.md for how to run that.
--
-- A few columns below (like "type", "status", "rights_status") just store
-- plain text instead of a fixed list of allowed values. That's on purpose:
-- it lets us add new valid values later without having to change the
-- database structure again.

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
  -- A single exam paper can end up with more than one rights record over
  -- time (e.g. if its permission status changes). This timestamp is what
  -- lets us figure out which one is the newest.
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
