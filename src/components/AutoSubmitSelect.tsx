// See src/components/SiteNav.tsx for what "use client" means. This
// component needs it because it responds live to the visitor changing a
// dropdown -- an onChange handler, below -- which only works in the
// browser, not on the server.
"use client";

// `SelectHTMLAttributes<HTMLSelectElement>` is a built-in React type
// meaning "every normal attribute a real HTML <select> element can take"
// (id, name, defaultValue, and so on) -- used below so this component can
// accept the exact same attributes as a plain <select> would.
import type { SelectHTMLAttributes } from "react";

/**
 * A dropdown menu that submits its surrounding search form the moment
 * someone picks a new option — so changing a filter on the results page
 * re-runs the search right away, instead of making you click "Search"
 * separately. This is only used for the filter dropdowns; the text search
 * box stays a normal input that still needs Search/Enter to be pressed,
 * matching how search already works.
 *
 * We use requestSubmit() rather than a plain form.submit() call, so the
 * form still submits the normal way (as a real page navigation) —
 * exactly like clicking the "Search" button already does, and it works
 * with the existing page without needing any other changes.
 */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    // `{...props}` spreads every attribute this component received (see the
    // spread operator in src/lib/db/queries.ts) directly onto the real
    // <select>, so callers can use <AutoSubmitSelect id="..." name="..." />
    // exactly like a plain <select>, without this file needing to list out
    // and forward each possible attribute one by one.
    <select
      {...props}
      onChange={(event) => {
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
