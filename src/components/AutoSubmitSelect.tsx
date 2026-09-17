"use client";

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
    <select
      {...props}
      onChange={(event) => {
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
