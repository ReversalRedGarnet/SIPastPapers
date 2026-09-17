import Link from "next/link";
import { Badge } from "@/components/Badge";
import type { ExamContentAvailability } from "@/lib/db/queries";
import { seriesIsEmpty } from "@/lib/browse-years";
import { seriesDisplayLabel } from "@/lib/format";
import type { ExamSeries } from "@/types/domain";

/**
 * The persistent "Explorer-style" left-hand navigation for the browse
 * drill-down (exam level → year). Plain server-rendered links — no
 * client JS needed, works without JavaScript.
 */
export function BrowseSidebar({
  examSeries,
  activeSeriesCode,
  years,
  activeYear,
  availability,
}: {
  examSeries: ExamSeries[];
  activeSeriesCode: string;
  years?: number[];
  activeYear?: number;
  availability: ExamContentAvailability;
}) {
  return (
    <nav aria-label="Exam levels" className="browse-sidebar">
      <ul>
        {examSeries.map((s) => {
          const isActive = s.code === activeSeriesCode;
          const isEmpty = seriesIsEmpty(s.code, availability);
          return (
            <li key={s.code}>
              <Link
                href={`/browse/${s.code}`}
                className={isActive ? "active" : undefined}
                aria-current={isActive ? "page" : undefined}
              >
                <span>{seriesDisplayLabel(s.code)}</span>
                {isEmpty && <Badge tone="neutral">No papers yet</Badge>}
              </Link>
              {/* `&&` chains can have more than two conditions -- every one has
                  to be true (not undefined, not empty) before the JSX at the
                  end is shown at all. */}
              {isActive && years && years.length > 0 && (
                <ul className="browse-sidebar__years">
                  {years.map((y) => {
                    const isYearActive = y === activeYear;
                    return (
                      <li key={y}>
                        <Link
                          href={`/browse/${s.code}/${y}`}
                          className={isYearActive ? "active" : undefined}
                          aria-current={isYearActive ? "page" : undefined}
                        >
                          {y}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
