"use client";

import Link from "next/link";
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
