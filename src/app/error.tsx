"use client";

import Link from "next/link";
import { useEffect } from "react";

// Error boundaries must be Client Components. This wraps every page/layout
// below the root layout (see AGENTS.md/Next's docs), so the site
// header/nav/footer still render around it -- only global-error.tsx (which
// replaces the whole <html>/<body>, not used here) would lose that chrome.
// Metadata exports aren't supported in a Client Component, so this page has
// no <title> override; it inherits the root layout's default title.
// `Error & { digest?: string }` is an "intersection type" (note the `&`,
// not `|`): it means this value must satisfy *both* sides at once -- a
// real, standard Error, *and* it must additionally have this optional
// `digest` field. `retry: () => void` is a function type: "this prop must
// be a function that takes no inputs and doesn't hand anything back."
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // `useEffect` is a hook (see src/components/SiteNav.tsx) for running some
  // code as a *side effect* of rendering -- here, logging the error --
  // rather than as part of describing what the page looks like. The `[error]`
  // at the end is its "dependency list": this effect only re-runs when
  // `error` itself changes to a new value, not on every single re-render.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <h1>Something went wrong</h1>
      <p className="lede" style={{ marginBottom: "1.5rem" }}>
        An unexpected error stopped this page from loading. It&apos;s been
        logged. Try again, or head back to the homepage.
      </p>

      {error.digest && (
        <p className="hint" style={{ marginBottom: "1.5rem" }}>
          Reference: <code>{error.digest}</code>
        </p>
      )}

      <div className="form-actions">
        <button type="button" onClick={() => retry()}>
          Try again
        </button>
        <Link href="/" className="button secondary">
          Go to homepage
        </Link>
      </div>
    </>
  );
}
