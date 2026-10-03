/** No database connection is made here: the snapshot tests load lists from memory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPagePathsSnapshot,
  judgePath,
  minReloadGapMs,
  refreshAfterMs,
  type PublicPagePaths,
} from "./public-paths";

const PATHS: PublicPagePaths = {
  seriesCodes: new Set(["sisc-l1", "sif3-sijsc"]),
  years: new Set([2015, 2016, 2025]),
  subjectSlugs: new Set(["mathematics", "english"]),
  paperPaths: new Set(["sisc-l1/2016/mathematics/paper-1", "sisc-l1/2016/mathematics/marking-scheme"]),
};

test("real browse and paper addresses exist", () => {
  for (const p of [
    "/browse",
    "/browse/sisc-l1",
    "/browse/sisc-l1/2016",
    "/browse/sisc-l1/2016/english", // a real combination with no papers yet still has a page
    "/exams/sisc-l1/2016/mathematics/paper-1",
    "/exams/sisc-l1/2016/mathematics/marking-scheme/",
  ]) {
    assert.equal(judgePath(PATHS, p), "exists", p);
  }
});

test("made-up browse and paper addresses are missing", () => {
  for (const p of [
    "/browse/nope",
    "/browse/sisc-l1/1900",
    "/browse/sisc-l1/2016.0",
    "/browse/sisc-l1/02016",
    "/browse/sisc-l1/2016/made-up-subject",
    "/exams/sisc-l1/2016/mathematics/made-up-paper",
    "/exams/sisc-l1/2016/mathematics/PAPER-1",
    "/exams/nope/1900/x/y",
    "/exams/sisc-l1/2016/mathematics/%E0%A4%A", // broken %-encoding
  ]) {
    assert.equal(judgePath(PATHS, p), "missing", p);
  }
});

test("addresses that aren't browse or paper pages are left to Next.js", () => {
  for (const p of ["/", "/about", "/results", "/exams", "/exams/sisc-l1/2016", "/browse/sisc-l1/2016/mathematics/extra"]) {
    assert.equal(judgePath(PATHS, p), "unchecked", p);
  }
});

test("percent-encoded segments are compared decoded", () => {
  const paths = { ...PATHS, paperPaths: new Set(["sisc-l1/2016/mathematics/paper-a b"]) };
  assert.equal(judgePath(paths, "/exams/sisc-l1/2016/mathematics/paper-a%20b"), "exists");
});

test("the refresh interval (default 300 s) and the minimum gap between reloads (default 30 s) can be set from the environment", () => {
  const names = ["PAGE_PATHS_REFRESH_SECONDS", "PAGE_PATHS_MIN_RELOAD_SECONDS"] as const;
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    assert.equal(refreshAfterMs(), 300_000);
    assert.equal(minReloadGapMs(), 30_000);
    process.env.PAGE_PATHS_REFRESH_SECONDS = "60";
    process.env.PAGE_PATHS_MIN_RELOAD_SECONDS = "10";
    assert.equal(refreshAfterMs(), 60_000);
    assert.equal(minReloadGapMs(), 10_000);
    process.env.PAGE_PATHS_REFRESH_SECONDS = "soon";
    process.env.PAGE_PATHS_MIN_RELOAD_SECONDS = "-5";
    assert.equal(refreshAfterMs(), 300_000, "an invalid value falls back to the default");
    assert.equal(minReloadGapMs(), 30_000, "an invalid value falls back to the default");
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});

// --- the snapshot: when the list is reloaded ---------------------------------
//
// `now` is passed in explicitly, in milliseconds, so no test waits for real.
// These use the default 300 s refresh and 30 s minimum gap.

const SECOND = 1000;
const OLD_PAPER = "/exams/sisc-l1/2016/mathematics/paper-1";
const NEW_PAPER = "/exams/sisc-l1/2016/mathematics/paper-2";
const BEFORE = ["sisc-l1/2016/mathematics/paper-1"];
const AFTER_PUBLISHING = [...BEFORE, "sisc-l1/2016/mathematics/paper-2"];

/** A loader returning each list in turn (the last one from then on), counting its calls. */
function loader(...paperPathLists: string[][]) {
  const counter = { calls: 0 };
  const load = async (): Promise<PublicPagePaths> => {
    const list = paperPathLists[Math.min(counter.calls, paperPathLists.length - 1)];
    counter.calls++;
    return { ...PATHS, paperPaths: new Set(list) };
  };
  return { load, counter };
}

test("a paper published after the list was loaded is found on its first request -- no 5-minute wait", async () => {
  const { load, counter } = loader(BEFORE, AFTER_PUBLISHING);
  const snapshot = createPagePathsSnapshot(load);
  assert.equal(await snapshot.judge(OLD_PAPER, 0), "exists");
  assert.equal(counter.calls, 1);

  // Published a minute later: not in the list, so the list is reloaded and
  // the page is found straight away.
  assert.equal(await snapshot.judge(NEW_PAPER, 60 * SECOND), "exists");
  assert.equal(counter.calls, 2);
});

test("within 30 s of the last reload, a paper not in the list waits for the gap -- at most 30 s, never 5 minutes", async () => {
  const { load, counter } = loader(BEFORE, AFTER_PUBLISHING);
  const snapshot = createPagePathsSnapshot(load);
  await snapshot.judge("/browse", 0);

  assert.equal(await snapshot.judge(NEW_PAPER, 10 * SECOND), "missing");
  assert.equal(counter.calls, 1, "no reload inside the gap");
  assert.equal(await snapshot.judge(NEW_PAPER, 30 * SECOND), "exists");
  assert.equal(counter.calls, 2);
});

test("made-up addresses can't force more than one reload per 30 s, however many arrive", async () => {
  const { load, counter } = loader(BEFORE);
  const snapshot = createPagePathsSnapshot(load);
  await snapshot.judge("/browse", 0);

  // A bot tries 300 made-up addresses over the next 30 seconds...
  for (let i = 0; i < 300; i++) {
    assert.equal(await snapshot.judge(`/exams/sisc-l1/2016/mathematics/made-up-${i}`, (i / 10) * SECOND), "missing");
  }
  assert.equal(counter.calls, 1, "...and causes no reload at all");

  // ...and 50 more arriving at the same moment once the gap is over share one.
  const verdicts = await Promise.all(
    Array.from({ length: 50 }, (_, i) => snapshot.judge(`/exams/nope/2016/x/${i}`, 31 * SECOND))
  );
  assert.ok(verdicts.every((v) => v === "missing"));
  assert.equal(counter.calls, 2, "one reload for all fifty");

  assert.equal(await snapshot.judge("/exams/nope/2016/x/again", 45 * SECOND), "missing");
  assert.equal(counter.calls, 2, "and none again until 30 s after that one");
});

test("the 300 s refresh still runs as a fallback: a withdrawn paper drops out of the list", async () => {
  const { load, counter } = loader(AFTER_PUBLISHING, BEFORE);
  const snapshot = createPagePathsSnapshot(load);
  assert.equal(await snapshot.judge(NEW_PAPER, 0), "exists");

  assert.equal(await snapshot.judge(NEW_PAPER, 299 * SECOND), "exists");
  assert.equal(counter.calls, 1, "no refresh before 300 s");

  // Past 300 s: answered from the current list while it reloads in the background.
  assert.equal(await snapshot.judge(NEW_PAPER, 301 * SECOND), "exists");
  assert.equal(counter.calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await snapshot.judge(NEW_PAPER, 302 * SECOND), "missing");
});

test("judging a prefetch from memory never loads the list", async () => {
  const { load, counter } = loader(BEFORE);
  const snapshot = createPagePathsSnapshot(load);
  assert.equal(snapshot.judgeFromMemory(NEW_PAPER, 0), "unchecked", "no list yet: let it through");
  assert.equal(counter.calls, 0);

  await snapshot.judge("/browse", 0);
  assert.equal(snapshot.judgeFromMemory(NEW_PAPER, 60 * SECOND), "missing");
  assert.equal(snapshot.judgeFromMemory(OLD_PAPER, 400 * SECOND), "exists");
  assert.equal(counter.calls, 1, "not even when the list is due a refresh");
});

test("while the list can't be loaded, requests go through and the database is retried at most once per 30 s", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const snapshot = createPagePathsSnapshot(async () => {
    calls++;
    throw new Error("database unreachable");
  });

  assert.equal(await snapshot.judge(NEW_PAPER, 0), "unchecked");
  assert.equal(await snapshot.judge(NEW_PAPER, 10 * SECOND), "unchecked");
  assert.equal(calls, 1);
  assert.equal(await snapshot.judge(NEW_PAPER, 30 * SECOND), "unchecked");
  assert.equal(calls, 2);
});
