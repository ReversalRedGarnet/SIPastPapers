#!/usr/bin/env node
/**
 * Reorganizes exam PDFs from a source folder tree into the structure the
 * SIPastPapers CLI's batch (directory) ingest mode expects:
 *   <OUTPUT>/<year>/<subject-slug>/<type-slug>[_<paper-no>].pdf
 *
 * Files are COPIED, not moved — your originals are left untouched.
 *
 * Filename matching is keyword/alias-based, not a fixed positional regex.
 * A shaped regex (`"F5 <Subject> Exam <yyyy>-formatted.pdf"`, or before
 * that `"<yyyy> - Year 9 - <Subject>.pdf"`) has broken on every batch so
 * far because exam-office filenames are never consistently formatted
 * across years (typos, missing words, inconsistent spacing/punctuation,
 * "FINAL"/"FORMATTED"/"revised" suffixes...). Instead:
 *
 *   1. Year: whichever 4-digit token appears in the filename. If none
 *      does (or it's malformed, e.g. a typo'd 3-digit year), falls back
 *      to a leading 4-digit token in the immediate parent folder name
 *      (works well when folders are named "<yyyy> ...", as this batch's
 *      are) — reported as a fallback, not silently assumed. If the
 *      filename and folder years disagree outright, the file is skipped
 *      rather than guessed at.
 *   2. Subject: whichever keyword/alias in COMMON_SUBJECT_KEYWORDS or the
 *      active --series's entry in SERIES_SUBJECT_KEYWORDS appears in the
 *      filename (case-insensitive, after stripping noise words like
 *      "exam"/"final"/"formatted"). Multi-word keywords are matched as
 *      substrings; single-word keywords are matched as whole words only,
 *      to avoid short tokens like "cat" or "dt" false-matching inside an
 *      unrelated word. Keyword resolution is scoped per --series because
 *      the same plain-language term can name two different real subjects
 *      depending on the series ("design tech" = Industrial Arts under
 *      sisc-l1, Design Technology under sisc-l2-sinf6).
 *
 * Any directory whose name starts with "solutions" (case-insensitive, at
 * any depth) is skipped entirely and reported separately — marking
 * schemes/solutions are deliberately never ingested, for any year or
 * level (see PROJECT_SPEC.md's decision log).
 *
 * Any non-.pdf file is reported as skipped rather than silently ignored,
 * so a stray .docx (or similar) doesn't just disappear from the report.
 *
 * Usage:
 *   node reorganize-papers.cjs <source-dir> <output-dir> --series <code>
 *
 * Example (Windows paths, quote them because of spaces):
 *   node reorganize-papers.cjs "C:\Users\you\Downloads\F5 Past Exams" ".\papers-ready" --series sisc-l1
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const positional = [];
  let series = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--series") {
      series = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { source: positional[0], output: positional[1], series };
}

const { source: SOURCE, output: OUTPUT, series: SERIES } = parseArgs(process.argv.slice(2));

if (!SOURCE || !OUTPUT || !SERIES) {
  console.error("Usage: node reorganize-papers.cjs <source-dir> <output-dir> --series <code>");
  process.exit(1);
}

const SOLUTIONS_DIR_RE = /^solutions/i;

// Words/tokens that carry no subject or year information and should never
// block a match. Matched as whole words after normalization.
const NOISE_WORDS = new Set([
  "sisc", "sinf6", "sinf6sc", "sinfsc", "exam", "exams", "final", "formatted",
  "formatting", "revised",
]);

// Subjects checked regardless of --series. Kept out of the per-series lists
// below because their wording doesn't collide with anything else across any
// series currently supported.
const COMMON_SUBJECT_KEYWORDS = [
  { subject: "agriculture", keywords: ["agriculture", "agric", "agri"] },
  { subject: "mathematics", keywords: ["mathematics", "mathmatics", "maths", "math"] },
  { subject: "science", keywords: ["science"] },
  { subject: "social-studies", keywords: ["social studies", "social stud", "social scie"] },
  // English is checked last within this group: "listening comprehension"
  // must win over the plain "english"/"eng" match when both would
  // otherwise be present.
  { subject: "english-listening", keywords: ["listening comprehension"] },
  { subject: "english", keywords: ["english", "eng"] },
];

// Series-specific keyword sets. "design tech" / "design technology" / "dt"
// is the reason this is scoped rather than one flat global list: it means
// Industrial Arts under sisc-l1 (F5's 2016/2018 files literally say
// "Design Tech"/"Design Technology", and 2017's say bare "DT") and it means
// Design Technology under sisc-l2-sinf6 (F6) -- the same plain-language
// term naming two different real subjects, depending on which series is
// actually being processed. A single global list can't disambiguate that;
// selecting the active keyword set by --series can.
const SERIES_SUBJECT_KEYWORDS = {
  "sisc-l1": [
    { subject: "business", keywords: ["business studies", "business stud", "business", "bus"] },
    { subject: "home-economics", keywords: ["home economics", "home eco", "heco", "h eco"] },
    {
      subject: "industrial-arts",
      keywords: [
        "industrial arts", "design technology", "desgn technology", "design tech",
        "destech", "ind arts", "indarts", "indart", "dt", "cat",
      ],
    },
    { subject: "new-testament-studies", keywords: ["new testament studies", "nts"] },
  ],
  "sisc-l2-sinf6": [
    { subject: "accounting", keywords: ["accounting", "acco", "acct", "acc"] },
    { subject: "biology", keywords: ["biology", "bio"] },
    { subject: "chemistry", keywords: ["chemistry", "chem"] },
    { subject: "computer-studies", keywords: ["computer studies", "computer", "comp stud", "comp"] },
    {
      // "dtfn" ("Design Tech Food & Nutrition") is 2017's lone DT file --
      // it needs its own keyword since "dtfn" doesn't contain "dt" as a
      // separate word (no boundary between "dt" and "fn"). It's included
      // here so the file resolves to design-technology at all; the
      // wood/food paper_no split below still leaves it as paper_no=null
      // deliberately, since "dtfn" itself matches neither "wood" nor
      // "food"/"nutrition"/"clothing" as a whole word.
      subject: "design-technology",
      keywords: ["design technology", "design tech", "designtech", "dtech", "dtec", "dt", "dtfn"],
    },
    {
      subject: "development-studies",
      keywords: ["development studies", "development", "dev studies", "dev stud", "devstud"],
    },
    { subject: "economics", keywords: ["economics", "econo"] },
    { subject: "geography", keywords: ["geography", "geo"] },
    { subject: "history", keywords: ["history"] },
    { subject: "physics", keywords: ["physics"] },
  ],
};

const ACTIVE_SUBJECT_KEYWORDS = [...COMMON_SUBJECT_KEYWORDS, ...(SERIES_SUBJECT_KEYWORDS[SERIES] ?? [])];

const SOCIAL_BARE_KEYWORD = "social";
const SOCIAL_STUDIES_SUBJECT = "social-studies";

/** true if `keyword` (already normalized) appears in `normalized`, respecting word boundaries for single-word keywords. */
function keywordMatches(normalized, words, keyword) {
  if (keyword.includes(" ")) {
    return normalized.includes(keyword);
  }
  return words.includes(keyword);
}

/**
 * Inserts a space at every letter<->digit boundary, so a subject word
 * glued directly to a year with no separator -- "English2021", "Exam25",
 * "Exam2025" -- splits into separately matchable tokens instead of one
 * fused word that matches nothing.
 */
function splitLetterDigitBoundaries(text) {
  return text.replace(/([a-zA-Z])(\d)/g, "$1 $2").replace(/(\d)([a-zA-Z])/g, "$1 $2");
}

/**
 * Normalizes a filename (no extension) to a space-separated, lowercased,
 * noise-word-stripped string for keyword matching. Any run of non-
 * alphanumeric characters -- dashes, underscores, periods, parentheses,
 * commas, whatever -- becomes a space (same philosophy as slugify() in
 * artifact-naming.ts), so "SISC-DesTech", "Dev.Stud", "Final(2)" and
 * "English2021" (after the letter<->digit split below) all tokenize the
 * same as their spaced-out equivalents.
 */
function normalize(base) {
  const spaced = splitLetterDigitBoundaries(base.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = spaced.split(" ").filter((w) => w && !NOISE_WORDS.has(w) && !/^f\d+$/.test(w));
  return { normalized: words.join(" "), words };
}

/**
 * Resolves a subject slug from a filename, or null if nothing matched.
 * Bare "social" only resolves to Social Studies when no other subject's
 * keyword also matched in the same filename -- it's a weak, generic word
 * that shouldn't outrank a real match if one happens to co-occur.
 */
function matchSubject(normalized, words) {
  for (const { subject, keywords } of ACTIVE_SUBJECT_KEYWORDS) {
    if (keywords.some((k) => keywordMatches(normalized, words, k))) {
      return subject === "english-listening" ? "english" : subject;
    }
  }
  if (words.includes(SOCIAL_BARE_KEYWORD)) {
    return SOCIAL_STUDIES_SUBJECT;
  }
  return null;
}

function isListeningComprehension(normalized) {
  return normalized.includes("listening comprehension");
}

/** true if "cat" appears as its own word (not as a substring of another word). */
function hasCatKeyword(words) {
  return words.includes("cat");
}

function hasDrawingSheet(normalized) {
  return normalized.includes("drawing sheet");
}

/** true if any of `wordList` appears as its own word (not a substring of another word). */
function hasAnyWord(words, wordList) {
  return wordList.some((w) => words.includes(w));
}

const YEAR_RE = /\b(\d{4})\b/;
// Year can appear anywhere in the folder name, not just at the start --
// "2015 SISC Exams" (F5) and "2016 Year 9" (F3) lead with it, but "SINF6
// 2015" (F6) doesn't.
const PARENT_YEAR_RE = /\b(\d{4})\b/;

function extractYear(text) {
  const m = text.match(YEAR_RE);
  return m ? m[1] : null;
}

const skippedDirs = [];

/**
 * Recursively collects every file under `dir` as { filePath, parentDirName },
 * skipping (and recording) any directory matching SOLUTIONS_DIR_RE so
 * marking schemes/solutions never reach the output tree, at any depth.
 */
function collectFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SOLUTIONS_DIR_RE.test(entry.name)) {
        skippedDirs.push(path.join(dir, entry.name));
        continue;
      }
      results.push(...collectFiles(path.join(dir, entry.name)));
    } else if (entry.isFile()) {
      results.push({ filePath: path.join(dir, entry.name), parentDirName: path.basename(dir) });
    }
  }
  return results;
}

if (!fs.existsSync(SOURCE)) {
  console.error(`Source directory not found: ${SOURCE}`);
  process.exit(1);
}

let copied = 0;
const skipped = [];
const resolved = []; // { rel, subject, type, paperNo, year, yearNote }
const commands = [];
const seenSubjectDirs = new Set();

const files = collectFiles(SOURCE);

for (const { filePath, parentDirName } of files) {
  const rel = path.relative(SOURCE, filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext !== ".pdf") {
    skipped.push(`${rel} — not a .pdf file (${ext || "no extension"}), left untouched`);
    continue;
  }

  const base = path.basename(filePath, ext);
  const { normalized, words } = normalize(base);

  const filenameYear = extractYear(splitLetterDigitBoundaries(base));
  const parentMatch = parentDirName.match(PARENT_YEAR_RE);
  const parentYear = parentMatch ? parentMatch[1] : null;

  let year;
  let yearNote = null;
  if (filenameYear && parentYear && filenameYear !== parentYear) {
    skipped.push(`${rel} — year conflict: filename says ${filenameYear}, folder "${parentDirName}" says ${parentYear}`);
    continue;
  } else if (filenameYear) {
    year = filenameYear;
  } else if (parentYear) {
    year = parentYear;
    yearNote = `year inferred from folder name "${parentDirName}" (no valid 4-digit year in filename)`;
  } else {
    skipped.push(`${rel} — no year found in filename or folder name`);
    continue;
  }

  const subject = matchSubject(normalized, words);
  if (!subject) {
    skipped.push(`${rel} — unrecognized subject (no keyword matched; add one to COMMON_SUBJECT_KEYWORDS or SERIES_SUBJECT_KEYWORDS if it's real)`);
    continue;
  }

  let type = "question-paper";
  let paperNo = null;
  if (subject === "english" && isListeningComprehension(normalized)) {
    type = "listening-comprehension";
  } else if (subject === "industrial-arts" && hasCatKeyword(words)) {
    type = "practical-paper";
    // BATCH_FILENAME_PATTERN's paper-no segment is [A-Za-z0-9]+ (no
    // hyphens), so "drawingsheet" not "drawing-sheet" here -- see cli-lib.ts.
    paperNo = hasDrawingSheet(normalized) ? "drawingsheet" : "cat";
  } else if (subject === "design-technology") {
    // Two parallel, mutually exclusive full papers -- not a main-paper-
    // plus-supplement relationship like Industrial Arts' CAT above -- so
    // type always stays question-paper; only paper_no distinguishes the
    // two streams (again no hyphen, per BATCH_FILENAME_PATTERN).
    if (words.includes("wood")) {
      paperNo = "woodmetal";
    } else if (hasAnyWord(words, ["food", "nutrition", "clothing"])) {
      paperNo = "foodclothing";
    }
    // Neither matches -> paperNo stays null: every single-file DT year,
    // including 2017's lone "DTFN" file. That file's own abbreviation
    // suggests "Food & Nutrition", but per the F6 audit it's deliberately
    // treated as that year's one generic paper (matching the convention
    // every other single-file subject/year already uses), not auto-tagged
    // foodclothing on the strength of the abbreviation alone.
  }

  const destDir = path.join(OUTPUT, year, subject);
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, paperNo ? `${type}_${paperNo}.pdf` : `${type}.pdf`);
  fs.copyFileSync(filePath, destFile);
  copied++;

  resolved.push({ rel, subject, type, paperNo, year, yearNote });

  const dirKey = `${year}::${subject}`;
  if (!seenSubjectDirs.has(dirKey)) {
    seenSubjectDirs.add(dirKey);
    commands.push(
      `npm run cli -- ingest "${destDir}" --series ${SERIES} --year ${year} --subject ${subject} --dry-run`
    );
  }
}

console.log(`\nCopied ${copied} file(s) into ${OUTPUT}\n`);

if (skippedDirs.length) {
  console.log("Excluded directories (solutions/marking schemes, never ingested):");
  for (const d of skippedDirs) console.log(`  - ${d}`);
  console.log("");
}

if (resolved.length) {
  console.log("Resolved:");
  for (const r of resolved) {
    const paperNoStr = r.paperNo ? ` paper-no=${r.paperNo}` : "";
    const noteStr = r.yearNote ? `  [${r.yearNote}]` : "";
    console.log(`  ${r.rel}  ->  year=${r.year} subject=${r.subject} type=${r.type}${paperNoStr}${noteStr}`);
  }
  console.log("");
}

if (skipped.length) {
  console.log("Skipped (needs a look):");
  for (const s of skipped) console.log(`  - ${s}`);
  console.log("");
}

if (commands.length) {
  console.log("Dry-run commands to check inferred type/paper-no per folder:");
  for (const c of commands.sort()) console.log(`  ${c}`);
  console.log("\nOnce each dry-run looks right, drop --dry-run to actually ingest.");
}
