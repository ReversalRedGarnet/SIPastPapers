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

const ITEMS = [
  { href: "/", label: "Home", exact: true },
  { href: "/browse", label: "Browse", exact: false },
  { href: "/results", label: "Search", exact: false },
  { href: "/about", label: "About", exact: false },
];

/**
 * Only the active-link highlighting needs client JS (usePathname) — the
 * links themselves would work perfectly well as plain server-rendered
 * anchors without it.
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
              <Link href={item.href} className={isActive ? "active" : undefined} aria-current={isActive ? "page" : undefined}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
