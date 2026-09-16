import type { Metadata } from "next";
import Link from "next/link";

// Root app/not-found.tsx handles both an explicit notFound() call from any
// route segment and any URL that doesn't match a route at all -- no need
// for the separate (experimental) global-not-found.js convention. It
// renders inside the root layout, so the site header/nav/footer already
// wrap this automatically.
export const metadata: Metadata = {
  title: "Page not found",
  description: "This page doesn't exist. Search or browse the SI National Exam Archive instead.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p className="lede" style={{ marginBottom: "1.5rem" }}>
        There&apos;s nothing at this address — the page may have moved, or the
        link might be wrong. Try searching for what you were after, or head
        back to the homepage.
      </p>

      <div className="card" style={{ maxWidth: "32rem" }}>
        <h2>Search papers</h2>
        <form method="get" action="/results" aria-label="Search the archive" className="search-form">
          <div className="field">
            <label htmlFor="q" className="visually-hidden">
              Search
            </label>
            <input type="search" id="q" name="q" placeholder="e.g. Mathematics 2018" style={{ maxWidth: "none" }} />
          </div>
          <button type="submit">Search</button>
        </form>
      </div>

      <p className="hint" style={{ marginTop: "1.5rem" }}>
        Or <Link href="/">return to the homepage</Link> or{" "}
        <Link href="/browse">browse the archive</Link>.
      </p>
    </>
  );
}
