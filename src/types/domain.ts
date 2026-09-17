/**
 * Domain types mirroring the relational schema in PROJECT_SPEC.md section 4.2
 * (see migrations/0001_init.sql for the actual Postgres schema). Only the
 * subset src/lib/db/queries.ts and the UI actually pass around by these
 * names is kept here — the query layer otherwise shapes rows with its own
 * per-query Row interfaces, not a full one-type-per-table mirror.
 */

// `type X = Y` gives an existing type a new, more meaningful name. This
// doesn't change how the value works at all (a UUID is still just plain
// text underneath) -- it just lets the rest of the code say "this needs to
// be a UUID" instead of a plain, easy-to-misuse "string," making the
// intent clearer to a reader.
export type UUID = string;

// --- exam_series ---------------------------------------------------------

// An `interface` describes the exact shape a piece of data must have --
// here, "anything called an ExamSeries always has an id, a code, a name,
// and a description." Nothing is actually built or run by writing this;
// it exists purely so TypeScript can check, everywhere this type is used,
// that the right fields are present with the right kinds of values.
export interface ExamSeries {
  id: UUID;
  code: string; // e.g. "sisc-l1"
  name: string; // e.g. "SISC Level 1"
  description: string | null;
}

// --- subjects ---------------------------------------------------------

export interface Subject {
  id: UUID;
  canonicalName: string; // e.g. "Mathematics"
  aliases: string[];
  subjectCode: string | null;
}

// --- artifacts ---------------------------------------------------------

/**
 * Controlled vocabularies below are not yet formalized in the spec
 * (section 4.3 is "to be defined"). These are a starting point derived from
 * language used elsewhere in the spec (Appendix A, sections 6.3, 8.3, 8.5)
 * and should be treated as provisional, not authoritative.
 */
// This is a "union type" of exact text values: ArtifactType must be one of
// these specific strings, word-for-word, and nothing else -- not "Question
// Paper," not "questionpaper," only exactly "question_paper" and the other
// options listed. Writing one option per line with a leading `|` is just a
// formatting style; it means precisely the same thing as writing them all
// on one line separated by `|`.
export type ArtifactType =
  | "question_paper"
  | "marking_scheme"
  | "examiner_report"
  | "listening_comprehension"
  | "practical_paper"
  | "other";

export type ArtifactStatus =
  | "draft"
  | "pending_review"
  | "rights_hold"
  | "published"
  | "withdrawn"
  | "not_yet_recovered";

export type VerificationStatus =
  | "unverified"
  | "source_verified"
  | "independently_verified"
  | "flagged";

export type RightsStatus =
  | "unknown"
  | "pending"
  // Auto-assigned to every new artifact's rights record on creation (see
  // src/lib/db/queries.ts ingestArtifact) so nothing can reach
  // "published" without an explicit later rights decision (see approveRights).
  | "pending_institutional_approval"
  | "permission_granted"
  | "public_domain_or_expired"
  | "rights_hold"
  | "denied";

export type SourceType =
  | "mehrd"
  | "school"
  | "teacher"
  | "former_student"
  | "community"
  | "other";

// --- sources ---------------------------------------------------------

export interface Source {
  id: UUID;
  sourceType: SourceType;
  organization: string | null;
  personLabel: string | null;
  url: string | null;
  attribution: string | null;
}

// --- Denormalized read shapes for the public UI -----------------------------

/**
 * A flattened, UI-friendly view of an artifact and its joined records —
 * shaped like Appendix A of PROJECT_SPEC.md. This is what search/results/
 * document pages actually render; produced by joining the tables above in
 * src/lib/db/queries.ts. Related artifacts (e.g. a marking scheme sharing
 * the same exam/subject) are returned alongside a record, not embedded in
 * it — see getPublicArtifactBySlug.
 */
export interface PublicExamRecord {
  id: UUID;
  slug: string; // used in the /exams/... URL, e.g. "paper-1" or "paper-1-marking-scheme"
  examSeriesCode: string;
  examSeriesName: string;
  subjectSlug: string;
  subject: string;
  year: number;
  artifactType: ArtifactType;
  paperNumber: string | null;
  title: string;
  status: ArtifactStatus;
  verification: VerificationStatus;
  rights: RightsStatus;
  // A type shape can be nested directly inside another one, instead of
  // being given its own separate name -- this says "the `file` field is
  // either an object with these four fields, or `null` when there isn't
  // a file yet," without needing a whole separate named interface just for
  // that small shape.
  file: {
    id: UUID; // used to build the /api/files/[fileId] view/download link
    sha256: string;
    mime: string;
    bytes: number;
  } | null; // null when status is "not_yet_recovered"
  source: {
    type: SourceType;
    organization: string | null;
    attribution: string | null;
  } | null;
}
