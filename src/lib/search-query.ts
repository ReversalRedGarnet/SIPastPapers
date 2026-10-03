/**
 * Turns what someone types in the search box into structured filters, so
 * "2018 maths", "Year 11 English" or "form 3 science paper 2" find what
 * they mean -- instead of the whole text having to appear, word for word,
 * in a paper's title.
 *
 *   - A 4-digit year (1950-2099) becomes a year filter.
 *   - An exam level, however it's written ("Year 11", "Form 5", "Level 1",
 *     "SISC L1", ...), becomes an exam-series filter.
 *   - "paper 2" must appear in the title as such.
 *   - Every other word must match the paper somewhere (title, subject,
 *     subject aliases or exam series name), where common short forms count
 *     too ("maths" -> Mathematics, "ms" -> Marking scheme).
 *   - Filler words ("past", "papers", "exam", ...) are ignored.
 *
 * Pure -- no database. src/lib/db/queries.ts turns the result into SQL.
 */

export interface ParsedSearch {
  years: number[];
  seriesCodes: string[];
  /**
   * Every group must match; within a group, any one of the alternatives
   * may (a word and its short forms). Lowercase, letters/digits/spaces/&.
   */
  termGroups: string[][];
}

/**
 * Ways people name each exam level. Matched as whole words, longest first
 * (so "sisc level 1" wins over "level 1"). Labels shown on the site are
 * "Form 3 / Year 9", "Form 5 / Year 11", "Form 6 / Year 12" (see
 * src/lib/format.ts); the database names are "SIF3 / SIJSC",
 * "SISC Level 1", "SISC Level 2 / SINF6".
 */
const SERIES_ALIASES: Record<string, string[]> = {
  "sif3-sijsc": ["form 3", "form three", "year 9", "year nine", "yr 9", "f3", "sif3", "sif 3", "sijsc"],
  "sisc-l1": ["form 5", "form five", "year 11", "year eleven", "yr 11", "f5", "sisc level 1", "sisc l1", "level 1", "l1"],
  "sisc-l2-sinf6": [
    "form 6",
    "form six",
    "year 12",
    "year twelve",
    "yr 12",
    "f6",
    "sisc level 2",
    "sisc l2",
    "level 2",
    "l2",
    "sinf6",
    "sinf 6",
  ],
};

/** "sisc" on its own covers both of its levels. */
const AMBIGUOUS_SERIES: Record<string, string[]> = {
  sisc: ["sisc-l1", "sisc-l2-sinf6"],
};

/** Short forms -> what they stand for (matched in addition to the word itself). */
const SYNONYMS: Record<string, string[]> = {
  maths: ["mathematics"],
  math: ["mathematics"],
  eng: ["english"],
  sci: ["science"],
  bio: ["biology"],
  chem: ["chemistry"],
  phys: ["physics"],
  geo: ["geography"],
  geog: ["geography"],
  hist: ["history"],
  econ: ["economics"],
  econs: ["economics"],
  ag: ["agriculture"],
  agric: ["agriculture"],
  acc: ["accounting"],
  accounts: ["accounting"],
  biz: ["business"],
  ict: ["computer"],
  computing: ["computer"],
  dt: ["design technology"],
  ia: ["industrial arts"],
  nts: ["new testament"],
  ms: ["marking scheme"],
  mark: ["marking"],
  marks: ["marking"],
  answers: ["marking scheme"],
  qp: ["question paper"],
};

/** Words that say nothing about which paper is wanted. */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "in",
  "to",
  "past",
  "paper",
  "papers",
  "exam",
  "exams",
  "examination",
  "examinations",
  "national",
  "si",
  "solomon",
  "islands",
  "pdf",
  "download",
  "free",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every alias, longest first, with the series it names.
const SERIES_PHRASES: { phrase: string; codes: string[] }[] = [
  ...Object.entries(SERIES_ALIASES).flatMap(([code, phrases]) => phrases.map((phrase) => ({ phrase, codes: [code] }))),
  ...Object.entries(AMBIGUOUS_SERIES).map(([phrase, codes]) => ({ phrase, codes })),
].sort((a, b) => b.phrase.length - a.phrase.length);

export function parseSearchQuery(query: string): ParsedSearch {
  // Lowercase; anything that isn't a letter, digit or "&" separates words
  // (so "Year-11", "year11"-style joins aside, punctuation never matters).
  let text = ` ${query.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim()} `;

  const seriesCodes = new Set<string>();
  for (const { phrase, codes } of SERIES_PHRASES) {
    const pattern = new RegExp(` ${escapeRegExp(phrase)} `, "g");
    if (pattern.test(text)) {
      codes.forEach((c) => seriesCodes.add(c));
      text = text.replace(pattern, "  ");
    }
  }

  const termGroups: string[][] = [];
  // "paper 2" -> the title must say "paper 2" (a bare "2" would match any year).
  text = text.replace(/ paper (\d{1,2}) /g, (_, n: string) => {
    termGroups.push([`paper ${n}`]);
    return "  ";
  });

  const years = new Set<number>();
  for (const word of text.split(" ").filter(Boolean)) {
    if (/^(19[5-9]\d|20\d\d)$/.test(word)) {
      years.add(Number(word));
      continue;
    }
    if (FILLER_WORDS.has(word)) continue;
    // Lone digits and single letters match almost everything -- skip them.
    if (/^\d{1,3}$/.test(word) || word.length < 2) continue;
    const group = [word, ...(SYNONYMS[word] ?? [])];
    if (!termGroups.some((g) => g.length === group.length && g.every((t, i) => t === group[i]))) termGroups.push(group);
  }

  return { years: [...years].sort(), seriesCodes: [...seriesCodes].sort(), termGroups };
}
