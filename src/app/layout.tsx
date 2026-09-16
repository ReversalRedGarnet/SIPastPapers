import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import "@fontsource/public-sans/latin-400.css";
import "@fontsource/public-sans/latin-500.css";
import "@fontsource/public-sans/latin-600.css";
import "@fontsource/public-sans/latin-700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SI National Exam Archive",
    template: "%s — SI National Exam Archive",
  },
  description:
    "A free archive of past Solomon Islands national examination papers. Search or browse by exam level, year and subject.",
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
