/**
 * Domain types mirroring the relational schema in PROJECT_SPEC.md section 4.2
 * (see migrations/sqlite/0001_init.sql for the local dev database). Used by
 * both the write path (src/lib/db/queries.ts) and the read-facing UI shape,
 * `PublicExamRecord` below.
 */

export type UUID = string;

// --- exam_series ---------------------------------------------------------

export interface ExamSeries {
  id: UUID;
  code: string; // e.g. "sisc-l1"
  name: string; // e.g. "SISC Level 1"
  description: string | null;
}

// --- exam_instances --------------------------------------------------------

export interface ExamInstance {
  id: UUID;
  examSeriesId: UUID;
  year: number;
  officialName: string | null;
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

export interface Artifact {
  id: UUID;
  examInstanceId: UUID;
  subjectId: UUID;
  type: ArtifactType;
  paperNo: string | null; // printed identifier: "1", "2", "A", "B", "—"
  title: string;
  status: ArtifactStatus;
  publishedAt: string | null; // ISO timestamp
}

// --- files ---------------------------------------------------------

export interface FileAsset {
  id: UUID;
  artifactId: UUID;
  storageKey: string;
  sha256: string;
  mime: string;
  bytes: number;
  createdAt: string;
}

// --- sources ---------------------------------------------------------

export interface Source {
  id: UUID;
  sourceType: SourceType;
  organization: string | null;
  personLabel: string | null;
  url: string | null;
  attribution: string | null;
}

export interface ArtifactSource {
  artifactId: UUID;
  sourceId: UUID;
  isPrimary: boolean;
  notes: string | null;
}

// --- verifications ---------------------------------------------------------

export interface Verification {
  id: UUID;
  artifactId: UUID;
  status: VerificationStatus;
  reviewer: string | null;
  checkedAt: string;
  notes: string | null;
}

// --- rights_records ---------------------------------------------------------

export interface RightsRecord {
  id: UUID;
  artifactId: UUID;
  rightsStatus: RightsStatus;
  basis: string | null;
  evidenceUri: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  expiryDate: string | null;
  notes: string | null;
}

// --- issues ---------------------------------------------------------

export type IssueStatus = "open" | "investigating" | "resolved" | "declined";

export interface Issue {
  id: UUID;
  artifactId: UUID;
  issueType: string;
  description: string;
  contact: string | null;
  status: IssueStatus;
  createdAt: string;
  resolvedAt: string | null;
}

// --- audit_events ---------------------------------------------------------

export interface AuditEvent {
  id: UUID;
  actorId: UUID | null;
  eventType: string;
  objectType: string;
  objectId: UUID;
  timestamp: string;
  metadata: Record<string, unknown>;
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
