"use client";

import Link from "next/link";
import { useEffect } from "react";

// Error boundaries must be Client Components. This wraps every page/layout
// below the root layout (see AGENTS.md/Next's docs), so the site
// header/nav/footer still render around it -- only global-error.tsx (which
// replaces the whole <html>/<body>, not used here) would lose that chrome.
// Metadata exports aren't supported in a Client Component, so this page has
// no <title> override; it inherits the root layout's default title.
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
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
