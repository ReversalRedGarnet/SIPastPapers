/**
 * Links that must not prefetch. Next.js prefetches a <Link> as soon as it
 * scrolls into view, so a link on every page to a page that isn't served
 * from cache costs a function run on every page load:
 *
 *   - /results is rendered fresh on every request;
 *   - /browse/... and /exams/... go through src/proxy.ts.
 *
 * Every <Link> in src whose address is written out (a string, a template
 * like `/browse/${code}`, or paperPath()/browseSubjectPath()) is checked
 * for prefetch={false}. Links whose address is a variable (e.g. the
 * /results page's own previous/next links) aren't checked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ITEMS } from "@/components/SiteNav";

const NO_PREFETCH = ["/results", "/browse", "/exams"];
const SRC = path.join(process.cwd(), "src");

function noPrefetchTarget(address: string): boolean {
  return NO_PREFETCH.some((p) => address === p || address.startsWith(`${p}/`) || address.startsWith(`${p}?`));
}

/** The start of a link's address, when it's written out; undefined for a variable. */
function addressOf(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) return expr.head.text;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (expr.expression.text === "paperPath") return "/exams/";
    if (expr.expression.text === "browseSubjectPath") return "/browse/";
  }
  return undefined;
}

interface FoundLink {
  where: string;
  address: string;
  prefetchFalse: boolean;
}

function linksIn(file: string): FoundLink[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: FoundLink[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "Link") {
      let address: string | undefined;
      let prefetchFalse = false;
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = attr.name.getText(source);
        const init = attr.initializer;
        if (name === "href" && init) {
          if (ts.isStringLiteral(init)) address = init.text;
          else if (ts.isJsxExpression(init) && init.expression) address = addressOf(init.expression);
        }
        if (name === "prefetch" && init && ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.FalseKeyword) {
          prefetchFalse = true;
        }
      }
      if (address !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ where: `${path.relative(process.cwd(), file)}:${line + 1}`, address, prefetchFalse });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function allLinks(): FoundLink[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => linksIn(path.join(SRC, f)));
}

test("every written-out link to /results, a browse page or a paper page has prefetch={false}", () => {
  const links = allLinks();
  const checked = links.filter((l) => noPrefetchTarget(l.address));
  // The check isn't vacuous: it sees the home page's "View all" link, among others.
  assert.ok(checked.some((l) => l.where.startsWith(path.join("src", "app", "page.tsx")) && l.address === "/results"));
  assert.ok(checked.length >= 10, `only ${checked.length} links found`);
  assert.deepEqual(
    checked.filter((l) => !l.prefetchFalse).map((l) => `${l.where} -> ${l.address}`),
    [],
    "these links prefetch a page that isn't served from cache"
  );
});

test("the nav doesn't prefetch Search or Browse, and still prefetches the static pages", () => {
  const prefetchOff = ITEMS.filter((i) => i.prefetch === false).map((i) => i.href);
  assert.deepEqual(prefetchOff.sort(), ["/browse", "/results"]);
  for (const item of ITEMS) assert.equal(item.prefetch === false, noPrefetchTarget(item.href), item.href);
});
