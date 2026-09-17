// The search results page always has to render fresh (see the note in
// page.tsx), so it can't be preloaded ahead of time. Without this file,
// clicking "Search" in the nav would show nothing at all until the whole
// page (search results plus all the filter dropdown options) finished
// loading — which made the click feel like it wasn't doing anything. This
// file is a built-in Next.js convention: it shows up immediately the
// moment someone navigates here, then gets swapped out for the real page
// once it's ready.
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
