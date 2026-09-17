/**
 * These are the shared shapes/types used to describe an exam paper and
 * everything connected to it, matching the database tables in
 * migrations/0001_init.sql. Only the specific fields that the database
 * layer (src/lib/db/queries.ts) and the rest of the app actually pass
 * around by these names are kept here — individual database queries often
 * define their own smaller, more specific shapes instead of reusing a
 * single type per database table.
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
 * The lists of allowed values below aren't officially finalized yet — this
 * is a starting point based on how these are described elsewhere in the
 * project spec, and should be treated as a draft, not the final word.
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
  // Automatically assigned to every new paper's rights record when it's
  // first added (see ingestArtifact in src/lib/db/queries.ts), so that a
  // paper can never become published without someone explicitly making a
  // rights decision on it later (see approveRights).
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
 * A single, flattened, ready-for-display view of one exam paper, combining
 * the details from several database tables into one convenient shape.
 * This is what the search, results, and individual paper pages actually
 * show — built by joining the underlying tables together in
 * src/lib/db/queries.ts. Related papers (like a marking scheme belonging
 * to the same exam and subject) are returned as a separate list alongside
 * this record, not nested inside it — see getPublicArtifactBySlug.
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
