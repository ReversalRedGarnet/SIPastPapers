import { query } from "./client";
import { PUBLICLY_VISIBLE } from "./visibility";
import { artifactSlug } from "@/lib/artifact-naming";
import { listBrowseYears } from "@/lib/browse-years";
import type { ArtifactType } from "@/types/domain";

/**
 * Which browse and paper page addresses actually exist -- so src/proxy.ts
 * can answer a made-up address with a 404 before Next.js renders anything.
 *
 * Why this is needed: browse-subject and paper pages are built the first
 * time they're visited and then stored as ISR pages. A page that turns out
 * not to exist is stored too (as a 404), so every made-up address a bot
 * tries would cost an ISR write and a stored page. Checking here first
 * means only real pages are ever built and stored.
 */
export interface PublicPagePaths {
  seriesCodes: Set<string>;
  years: Set<number>;
  subjectSlugs: Set<string>;
  /** "series/year/subject/slug" for every paper page the public can see. */
  paperPaths: Set<string>;
}

export async function loadPublicPagePaths(): Promise<PublicPagePaths> {
  const [series, subjects, papers] = await Promise.all([
    query<{ code: string }>("select code from exam_series"),
    // The same slug the browse pages match on: subject_code, or the id
    // when a subject has no code.
    query<{ slug: string }>("select coalesce(subject_code, id::text) as slug from subjects"),
    query<{ code: string; year: number; subject_code: string | null; type: ArtifactType; paper_no: string | null }>(
      `select es.code, ei.year, s.subject_code, a.type, a.paper_no
       from artifacts a
       join exam_instances ei on ei.id = a.exam_instance_id
       join exam_series es on es.id = ei.exam_series_id
       join subjects s on s.id = a.subject_id
       where ${PUBLICLY_VISIBLE}`
    ),
  ]);
  return {
    seriesCodes: new Set(series.map((r) => r.code)),
    years: new Set(listBrowseYears()),
    subjectSlugs: new Set(subjects.map((r) => r.slug)),
    paperPaths: new Set(
      papers
        .filter((p) => p.subject_code)
        .map((p) => `${p.code}/${p.year}/${p.subject_code}/${artifactSlug({ artifactType: p.type, paperNo: p.paper_no })}`)
    ),
  };
}

/**
 * "exists": a real page. "missing": an address in the shape of a browse or
 * paper page that doesn't exist. "unchecked": anything else (left to
 * Next.js as usual).
 */
export type PathVerdict = "exists" | "missing" | "unchecked";

export function judgePath(paths: PublicPagePaths, pathname: string): PathVerdict {
  let segments: string[];
  try {
    segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return "missing"; // malformed %-encoding can't name a real page
  }
  const [section, series, year, subject, slug, ...rest] = segments;
  if (section !== "browse" && section !== "exams") return "unchecked";

  const yearOk = () => /^\d{4}$/.test(year) && paths.years.has(Number(year));

  if (section === "browse") {
    if (rest.length > 0 || slug !== undefined) return "unchecked"; // no such route: Next's own 404
    if (series === undefined) return "exists"; // /browse
    if (!paths.seriesCodes.has(series)) return "missing";
    if (year === undefined) return "exists";
    if (!yearOk()) return "missing";
    if (subject === undefined) return "exists";
    return paths.subjectSlugs.has(subject) ? "exists" : "missing";
  }

  // /exams only has the full four-part paper address.
  if (slug === undefined || rest.length > 0) return "unchecked";
  return paths.paperPaths.has(`${series}/${year}/${subject}/${slug}`) ? "exists" : "missing";
}

// --- the snapshot the proxy uses -------------------------------------------
//
// Loaded from the database at most once per refresh interval per running
// copy of the app, not on every request. A paper published (or withdrawn)
// is picked up within about that interval; until then a withdrawn paper's
// page answers for itself, and a newly published one gets a 404 (not
// stored anywhere).

const DEFAULT_REFRESH_SECONDS = 300;

/**
 * PAGE_PATHS_REFRESH_SECONDS (default 300): how often the list of real
 * addresses is reloaded. Read each time (it's cheap) so tests can change it.
 */
export function refreshAfterMs(): number {
  const raw = process.env.PAGE_PATHS_REFRESH_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_REFRESH_SECONDS * 1000;
  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds > 0) return seconds * 1000;
  console.warn(
    `[public-paths] PAGE_PATHS_REFRESH_SECONDS="${raw}" isn't a whole number above 0 -- using ${DEFAULT_REFRESH_SECONDS}.`
  );
  return DEFAULT_REFRESH_SECONDS * 1000;
}

/** Past this, a snapshot that can't be refreshed is no longer trusted: two missed refreshes, and at least 10 minutes. */
function giveUpAfterMs(): number {
  return Math.max(10 * 60_000, 2 * refreshAfterMs());
}
/** How long a request waits for the very first snapshot before going ahead without one. */
const FIRST_LOAD_WAIT_MS = 1_500;

let snapshot: { paths: PublicPagePaths; loadedAt: number } | undefined;
let loading: Promise<void> | undefined;

function refresh(now: number): Promise<void> {
  loading ??= loadPublicPagePaths()
    .then((paths) => {
      snapshot = { paths, loadedAt: now };
    })
    .catch((err) => {
      console.error(`[public-paths] couldn't load page addresses: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

/**
 * The current snapshot, or undefined if there isn't a usable one -- in which
 * case the caller should let the request through (fail open: the page
 * itself still returns its own 404).
 */
export async function getPublicPagePaths(now: number = Date.now()): Promise<PublicPagePaths | undefined> {
  if (!snapshot) {
    await Promise.race([refresh(now), new Promise((resolve) => setTimeout(resolve, FIRST_LOAD_WAIT_MS))]);
  } else if (now - snapshot.loadedAt > refreshAfterMs()) {
    void refresh(now); // answer from the current snapshot meanwhile
  }
  if (!snapshot || now - snapshot.loadedAt > giveUpAfterMs()) return undefined;
  return snapshot.paths;
}
