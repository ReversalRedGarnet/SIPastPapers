"use client";

import Link from "next/link";
import { useEffect } from "react";
import { isTransientConnectionError } from "@/lib/db/transient-error";

// This is the page shown whenever something goes wrong loading any page on
// the site. It has to run in the browser (rather than only on the
// server), which is a technical requirement for this kind of "catch any
// error" page in Next.js. Because it wraps every page under the main
// layout, the site's header/nav/footer still show up around this error
// message. This page also can't set its own browser tab title (another
// technical limitation of this kind of page), so it just uses the site's
// default title.
//
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

  const isColdDb = isTransientConnectionError(error);

  return (
    <>
      <h1>Something went wrong</h1>
      <p className="lede" style={{ marginBottom: "1.5rem" }}>
        {isColdDb
          ? "The database is waking up — please try again in a moment."
          : "An unexpected error stopped this page from loading. It's been logged. Try again, or head back to the homepage."}
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
