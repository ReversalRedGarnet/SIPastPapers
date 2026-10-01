import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTACT_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, HONEYPOT_FIELD, parseReportForm, safeReturnTo } from "./report-form";
import { reportStatusHref } from "./report-status";
import { isUuid } from "./uuid";

const ARTIFACT_ID = "eab44084-e61f-4a48-9dcb-14324c5ccfe7";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

test("a normal report is accepted, trimmed, with a blank contact treated as none", () => {
  assert.deepEqual(
    parseReportForm(
      form({ artifactId: ARTIFACT_ID, issueType: "wrong_metadata", description: "  Wrong year  ", contact: "   " })
    ),
    { kind: "ok", artifactId: ARTIFACT_ID, issueType: "wrong_metadata", description: "Wrong year", contact: null }
  );
});

test("an unknown issue type falls back to 'other'", () => {
  const parsed = parseReportForm(form({ artifactId: ARTIFACT_ID, issueType: "drop table", description: "x" }));
  assert.equal(parsed.kind === "ok" && parsed.issueType, "other");
});

test("an id that isn't a UUID is refused before it can reach the database", () => {
  assert.deepEqual(parseReportForm(form({ artifactId: "1 or 1=1", description: "x" })), {
    kind: "invalid",
    code: "unknown-paper",
  });
});

test("an empty description is refused", () => {
  assert.deepEqual(parseReportForm(form({ artifactId: ARTIFACT_ID, description: "   " })), {
    kind: "invalid",
    code: "missing-details",
  });
});

test("overlong details or contact are refused", () => {
  const tooLong = { kind: "invalid", code: "too-long" };
  assert.deepEqual(
    parseReportForm(form({ artifactId: ARTIFACT_ID, description: "x".repeat(DESCRIPTION_MAX_LENGTH + 1) })),
    tooLong
  );
  assert.deepEqual(
    parseReportForm(form({ artifactId: ARTIFACT_ID, description: "x", contact: "a".repeat(CONTACT_MAX_LENGTH + 1) })),
    tooLong
  );
  assert.equal(
    parseReportForm(form({ artifactId: ARTIFACT_ID, description: "x".repeat(DESCRIPTION_MAX_LENGTH) })).kind,
    "ok"
  );
});

test("anything in the spam-trap field marks the report as spam", () => {
  assert.deepEqual(
    parseReportForm(form({ artifactId: ARTIFACT_ID, description: "buy now", [HONEYPOT_FIELD]: "http://spam.example" })),
    { kind: "spam" }
  );
});

test("safeReturnTo only allows paths on this site", () => {
  assert.equal(safeReturnTo("/exams/sisc-l1/2019/mathematics/paper-1"), "/exams/sisc-l1/2019/mathematics/paper-1");
  assert.equal(safeReturnTo("//evil.example/x"), "/");
  assert.equal(safeReturnTo("https://evil.example/x"), "/");
  assert.equal(safeReturnTo(null), "/");
});

test("reportStatusHref adds the code and anchor, keeping any existing query string", () => {
  assert.equal(reportStatusHref("/exams/a/2019/b/paper-1", "sent"), "/exams/a/2019/b/paper-1?report=sent#report-a-problem");
  assert.equal(
    reportStatusHref("/exams/a/2019/b/paper-1?x=1", "too-long"),
    "/exams/a/2019/b/paper-1?x=1&report=too-long#report-a-problem"
  );
  assert.equal(
    reportStatusHref("/exams/a/2019/b/paper-1?report=sent", "missing-details"),
    "/exams/a/2019/b/paper-1?report=missing-details#report-a-problem",
    "a stale code is replaced, not duplicated"
  );
});

test("isUuid", () => {
  assert.equal(isUuid(ARTIFACT_ID), true);
  assert.equal(isUuid(ARTIFACT_ID.toUpperCase()), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(`${ARTIFACT_ID}x`), false);
});
