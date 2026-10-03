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
// The list is held in memory by each running copy of the app and reloaded:
//
// - when an address isn't in it (a paper may have been published since it
//   was loaded) -- but at most once per PAGE_PATHS_MIN_RELOAD_SECONDS
//   (default 30), so a bot trying made-up addresses can't force a database
//   query per request; a miss inside that gap is answered from the list as
//   it stands;
// - every PAGE_PATHS_REFRESH_SECONDS (default 300) in the background, as a
//   fallback -- this is what drops a withdrawn paper (until then its page
//   answers for itself).

const DEFAULT_REFRESH_SECONDS = 300;
const DEFAULT_MIN_RELOAD_SECONDS = 30;

function secondsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback * 1000;
  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds > 0) return seconds * 1000;
  console.warn(`[public-paths] ${name}="${raw}" isn't a whole number above 0 -- using ${fallback}.`);
  return fallback * 1000;
}

/**
 * PAGE_PATHS_REFRESH_SECONDS (default 300): how often the list of real
 * addresses is reloaded regardless. Read each time (it's cheap) so tests
 * can change it.
 */
export function refreshAfterMs(): number {
  return secondsFromEnv("PAGE_PATHS_REFRESH_SECONDS", DEFAULT_REFRESH_SECONDS);
}

/**
 * PAGE_PATHS_MIN_RELOAD_SECONDS (default 30): the shortest gap between two
 * reloads triggered by addresses that aren't in the list.
 */
export function minReloadGapMs(): number {
  return secondsFromEnv("PAGE_PATHS_MIN_RELOAD_SECONDS", DEFAULT_MIN_RELOAD_SECONDS);
}

/** Past this, a snapshot that can't be refreshed is no longer trusted: two missed refreshes, and at least 10 minutes. */
function giveUpAfterMs(): number {
  return Math.max(10 * 60_000, 2 * refreshAfterMs());
}
/** How long a request waits for the very first snapshot before going ahead without one. */
const FIRST_LOAD_WAIT_MS = 1_500;
/** How long a request for an address not in the list waits for the reload it triggered. */
const MISS_RELOAD_WAIT_MS = 3_000;

function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface PagePathsSnapshot {
  /**
   * The verdict on an address, reloading the list first if needed (see
   * above). "unchecked" when there's no usable list -- the caller lets the
   * request through (fail open: the page itself still returns its own 404).
   */
  judge(pathname: string, now?: number): Promise<PathVerdict>;
  /**
   * The verdict from the list as it stands, with no database work at all;
   * "no list" when there's no usable list in memory.
   */
  judgeFromMemory(pathname: string, now?: number): PathVerdict | "no list";
}

/**
 * `load` is loadPublicPagePaths in the app; tests pass their own, and may
 * wait longer for a slow test database.
 */
export function createPagePathsSnapshot(
  load: () => Promise<PublicPagePaths>,
  { firstLoadWaitMs = FIRST_LOAD_WAIT_MS, missReloadWaitMs = MISS_RELOAD_WAIT_MS } = {}
): PagePathsSnapshot {
  let snapshot: { paths: PublicPagePaths; loadedAt: number } | undefined;
  let loading: Promise<void> | undefined;
  let lastLoadStartedAt = -Infinity;

  function reload(now: number): Promise<void> {
    if (!loading) {
      lastLoadStartedAt = now;
      loading = load()
        .then((paths) => {
          snapshot = { paths, loadedAt: now };
        })
        .catch((err) => {
          console.error(`[public-paths] couldn't load page addresses: ${err instanceof Error ? err.message : err}`);
        })
        .finally(() => {
          loading = undefined;
        });
    }
    return loading;
  }

  function judgeFromMemory(pathname: string, now: number = Date.now()): PathVerdict | "no list" {
    if (!snapshot || now - snapshot.loadedAt > giveUpAfterMs()) return "no list";
    return judgePath(snapshot.paths, pathname);
  }

  /** As judgeFromMemory, but with no list the request is let through. */
  function judgeLoaded(pathname: string, now: number): PathVerdict {
    const verdict = judgeFromMemory(pathname, now);
    return verdict === "no list" ? "unchecked" : verdict;
  }

  async function judge(pathname: string, now: number = Date.now()): Promise<PathVerdict> {
    if (!snapshot) {
      // The same minimum gap applies while there's no list yet (the first
      // load failed), so an unreachable database isn't retried per request.
      if (loading || now - lastLoadStartedAt >= minReloadGapMs()) {
        await waitAtMost(reload(now), firstLoadWaitMs);
      }
    } else if (now - snapshot.loadedAt > refreshAfterMs()) {
      void reload(now); // answer from the current list meanwhile
    }

    const verdict = judgeLoaded(pathname, now);
    if (verdict !== "missing") return verdict;

    // Not in the list -- perhaps published since it was loaded. Wait for a
    // reload already under way, or start one if the last was long enough ago.
    if (loading) {
      await waitAtMost(loading, missReloadWaitMs);
    } else if (now - lastLoadStartedAt >= minReloadGapMs()) {
      await waitAtMost(reload(now), missReloadWaitMs);
    } else {
      return verdict;
    }
    return judgeLoaded(pathname, now);
  }

  return { judge, judgeFromMemory };
}

/** The one list each running copy of the app shares. */
export const publicPagePaths = createPagePathsSnapshot(loadPublicPagePaths);
