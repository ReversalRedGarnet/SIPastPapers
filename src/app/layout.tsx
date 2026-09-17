import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import "@fontsource/public-sans/latin-400.css";
import "@fontsource/public-sans/latin-500.css";
import "@fontsource/public-sans/latin-600.css";
import "@fontsource/public-sans/latin-700.css";
import "./globals.css";

const DESCRIPTION =
  "A free archive of past Solomon Islands national examination papers. Search or browse SIF3/SIJSC, SISC Level 1 and SISC Level 2/SINF6 exam papers by year and subject.";

export const metadata: Metadata = {
  // Setting this here means every other page can use a short, relative
  // path for its own link-related metadata (like the "shareable link"
  // preview info), instead of having to write out the full
  // "https://..." address every single time.
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s — ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  // Any page that doesn't set its own social-media preview info
  // (its "openGraph" details) uses this one instead — it's a full
  // replacement, not a partial fill-in, if a page does set its own. So
  // this effectively serves as both the homepage's preview info and the
  // fallback for every other page.
  openGraph: {
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: DESCRIPTION,
    type: "website",
    locale: "en_US",
  },
  verification: {
    google: "F8VMQqnJhG3mLs9aqt7MBZm5e18qA98_Yq0v0JA1Go8",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="site-header">
          <div className="site-header__inner">
            <Link href="/" className="site-title">
              SI National Exam Archive
            </Link>
            <SiteNav />
          </div>
        </header>
        <main id="main-content">{children}</main>
        <footer className="site-footer">
          <div className="site-footer__inner">
            <span>SI National Exam Archive</span>
            <nav aria-label="Footer">
              <Link href="/about">About</Link>
              <Link href="/about#corrections">Report an issue</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
