// /results reads searchParams and is force-dynamic (see page.tsx), so it
// can't be statically prefetched -- without this file, clicking "Search"
// in the nav had nothing to show until the full page (results query +
// filter option lists) finished resolving, which read as the click doing
// nothing. This file is Next's Suspense-fallback convention: it renders
// immediately on navigation and is swapped for the real page once ready.
export default function Loading() {
  return (
    <>
      <h1 className="visually-hidden">Search papers</h1>
      <p className="lede" style={{ margin: "1rem 0" }}>
        Loading results…
      </p>
    </>
  );
}
