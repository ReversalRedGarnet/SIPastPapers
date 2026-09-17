"use client";

import Link from "next/link";
import { useEffect } from "react";

// This is the page shown whenever something goes wrong loading any page on
// the site. It has to run in the browser (rather than only on the
// server), which is a technical requirement for this kind of "catch any
// error" page in Next.js. Because it wraps every page under the main
// layout, the site's header/nav/footer still show up around this error
// message. This page also can't set its own browser tab title (another
// technical limitation of this kind of page), so it just uses the site's
// default title.
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
