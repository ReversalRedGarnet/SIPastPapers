"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * The PDF preview box on a paper's page. On a phone it starts out empty,
 * with a "Show preview" button, instead of loading the whole PDF straight
 * away: most phone browsers can't show a PDF inside a page anyway (the box
 * just stays blank), yet the full file would still be downloaded --
 * costing the visitor their mobile data, and then again when they press
 * Download. On a wide screen (where previews do work) it loads straight
 * away, as before.
 *
 * Without JavaScript, the "Show preview" button is an ordinary link that
 * opens the PDF itself, so it still works.
 */

// Matches the point where .doc-layout in globals.css switches from one
// column (phones) to two (wider screens).
const WIDE_SCREEN_QUERY = "(min-width: 55rem)";

// `useSyncExternalStore` lets a component follow something that lives
// outside React -- here, whether the screen is currently wide. React calls
// `subscribe` to be told when that changes, and the "snapshot" function to
// read the current value. On the server there's no screen to measure, so
// the third function says "assume narrow", which is why the server-rendered
// page always starts with the button.
function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_SCREEN_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isWideScreenNow(): boolean {
  return window.matchMedia(WIDE_SCREEN_QUERY).matches;
}

function assumeNarrowOnServer(): boolean {
  return false;
}

export function PdfPreview({ src, title, sizeLabel }: { src: string; title: string; sizeLabel: string }) {
  const isWideScreen = useSyncExternalStore(subscribe, isWideScreenNow, assumeNarrowOnServer);
  const [requested, setRequested] = useState(false);

  if (requested || isWideScreen) {
    return <iframe src={src} className="pdf-frame" title={title} />;
  }

  return (
    <div className="empty-state" style={{ border: "none" }}>
      <p style={{ marginTop: 0 }}>The preview isn&apos;t loaded automatically, to save your mobile data.</p>
      <a
        className="button secondary"
        href={src}
        onClick={(event) => {
          // With JavaScript running, show the preview here instead of
          // following the link to the bare PDF.
          event.preventDefault();
          setRequested(true);
        }}
      >
        Show preview ({sizeLabel})
      </a>
      <p className="hint" style={{ marginBottom: 0 }}>
        Some phones can&apos;t show previews. If it stays blank, use Download or Open in new tab instead.
      </p>
    </div>
  );
}
