import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/Badge";
import { getExamContentAvailability, listExamSeries } from "@/lib/db/queries";
import { seriesIsEmpty } from "@/lib/browse-years";
import { seriesDisplayLabel } from "@/lib/format";

export const metadata: Metadata = {
  title: "Browse",
};

// The exam series list essentially never changes (a new series is a rare,
// deliberate addition, not routine content) — long revalidate window.
export const revalidate = 3600;

export default async function BrowsePage() {
  const examSeries = await listExamSeries();
  const availability = await getExamContentAvailability();

  return (
    <>
      <h1>Browse</h1>
      <p className="lede" style={{ marginBottom: "1.25rem" }}>
        Select an exam level to see its years, then a subject and paper.
      </p>

      {examSeries.length === 0 ? (
        <p className="empty-state">No exam levels have been set up yet.</p>
      ) : (
        <ul className="list-rows">
          {examSeries.map((s) => (
            <li key={s.code}>
              <Link href={`/browse/${s.code}`} className="list-row">
                <span className="list-row__label">{seriesDisplayLabel(s.code)}</span>
                {seriesIsEmpty(s.code, availability) && <Badge tone="neutral">No papers yet</Badge>}
                <span className="list-row__chevron" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
