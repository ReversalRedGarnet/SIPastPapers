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
