// See src/components/SiteNav.tsx for what "use client" means. This
// component needs it because it responds live to the visitor changing a
// dropdown -- an onChange handler, below -- which only works in the
// browser, not on the server.
"use client";

// `SelectHTMLAttributes<HTMLSelectElement>` is a built-in React type
// meaning "every normal attribute a real HTML <select> element can take"
// (id, name, defaultValue, and so on) -- used below so this component can
// accept the exact same attributes as a plain <select> would.
import { useRef, type SelectHTMLAttributes } from "react";

/**
 * A dropdown menu that submits its surrounding search form the moment
 * someone picks a new option with a mouse or finger — so changing a filter
 * on the results page re-runs the search right away, instead of making you
 * click "Search" separately. This is only used for the filter dropdowns;
 * the text search box stays a normal input that still needs Search/Enter
 * to be pressed, matching how search already works.
 *
 * With a keyboard, some browsers (e.g. Firefox on Windows) report a change
 * on every arrow key press, which would reload the page at each option on
 * the way to the one wanted (WCAG 3.2.2, "On Input"). So a change made
 * from the keyboard waits for Enter instead.
 *
 * We use requestSubmit() rather than a plain form.submit() call, so the
 * form still submits the normal way (as a real page navigation) —
 * exactly like clicking the "Search" button already does, and it works
 * with the existing page without needing any other changes.
 */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  // `useRef` keeps a value between renders without causing a re-render
  // when it changes -- here, whether the last thing the visitor did with
  // this dropdown was a key press.
  const usingKeyboard = useRef(false);
  return (
    // `{...props}` spreads every attribute this component received (see the
    // spread operator in src/lib/db/queries.ts) directly onto the real
    // <select>, so callers can use <AutoSubmitSelect id="..." name="..." />
    // exactly like a plain <select>, without this file needing to list out
    // and forward each possible attribute one by one.
    <select
      {...props}
      onPointerDown={() => {
        usingKeyboard.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        } else {
          usingKeyboard.current = true;
        }
      }}
      onChange={(event) => {
        if (!usingKeyboard.current) event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
