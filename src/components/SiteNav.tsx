// The `"use client"` line at the very top of a file tells Next.js "render
// this one in the visitor's own browser, not on the server." Every page
// component seen so far (the homepage, /results) runs on the server by
// default, which is faster and lets them talk to the database directly --
// but they can't react to things happening live in the browser, like
// tracking which page the visitor is currently on. This file needs exactly
// that (see usePathname below), so it opts into being a "client component"
// instead.
"use client";

import Link from "next/link";
// `usePathname` is a "hook" -- in React, a hook is a special function
// (always starting with "use") that lets a component tap into some extra
// browser/React capability, here "what's the current page's address?"
// Hooks only work inside client components, which is exactly why this file
// needs the "use client" line above.
import { usePathname } from "next/navigation";

// `prefetch: false`: browse pages go through src/proxy.ts, and /results is
// rendered fresh on every request -- prefetching either would cost a
// function run on every page load (src/lib/link-prefetch.test.ts checks
// this). The other pages are static and prefetch for free.
export const ITEMS: { href: string; label: string; exact: boolean; prefetch?: false }[] = [
  { href: "/", label: "Home", exact: true },
  { href: "/browse", label: "Browse", exact: false, prefetch: false },
  { href: "/results", label: "Search", exact: false, prefetch: false },
  { href: "/missing", label: "Missing papers", exact: false },
  { href: "/about", label: "About", exact: false },
];

/**
 * The only reason this needs client-side JavaScript at all is to
 * highlight which nav link is currently active (it needs to check the
 * current page's web address). The links themselves would work fine as
 * plain, server-rendered links without any JavaScript.
 */
export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary">
      <ul className="site-nav">
        {ITEMS.map((item) => {
          const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={item.prefetch}
                className={isActive ? "active" : undefined}
                aria-current={isActive ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
