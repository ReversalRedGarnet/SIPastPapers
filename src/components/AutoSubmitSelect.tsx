"use client";

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
    <select
      {...props}
      onChange={(event) => {
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
