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
 * A <select> that submits its enclosing form the moment its value changes,
 * so picking a new filter on /results re-runs the search immediately
 * instead of waiting for "Search" to be clicked. Only used for the filter
 * dropdowns -- the text query box stays a plain input, still requiring
 * Search/Enter, per the existing search UX.
 *
 * requestSubmit() (not form.submit()) so the form's own method/action
 * still drives navigation -- a real GET, matching what clicking "Search"
 * already does, and works with `search-form--inline`'s existing markup
 * with no other page changes needed.
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
