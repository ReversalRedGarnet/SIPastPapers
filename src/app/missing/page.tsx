import type { Metadata } from "next";
import { getCoverageMatrix } from "@/lib/db/queries";
import { deriveMissingPaperRows, type MissingPaperRow } from "@/lib/missing-papers";
import { seriesDisplayLabel } from "@/lib/format";
import { artifactTypeLabel } from "@/lib/artifact-naming";
import { CONTACT_EMAIL } from "@/lib/site";
import { Badge } from "@/components/Badge";

export const metadata: Metadata = {
  title: "Missing papers",
  description:
    "Every past Solomon Islands national exam paper we know about but don't have a copy of yet. Have one? Email it in.",
  alternates: { canonical: "/missing" },
};

// Same reasoning as the browse pages -- this only changes when the
// operator publishes/unpublishes something via the command-line tool.
export const revalidate = 300;

/**
 * Builds a mailto link with a prefilled subject line naming the exact
 * paper, so a reply lands in the inbox already labelled with what it's
 * about instead of a bare "I have this" with no context.
 */
function mailtoHref(row: MissingPaperRow): string {
  const subject = `I have: ${row.examSeriesName} ${row.subjectName} ${row.year} (${row.missingTypes.join(" + ")})`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

// A small inline icon rather than a library import -- this is the only
// icon on the page, so pulling in an icon package for one shape isn't
// worth it. `aria-hidden` because the link it sits inside already has its
// own accessible name.
function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="16" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 5.5L10 11L17 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function MissingPapersPage() {
  const cells = await getCoverageMatrix();
  const rows = deriveMissingPaperRows(cells);

  // Grouped the same way the `coverage` command-line tool groups its own
  // output -- one block per exam series, in the order rows already come
  // in (deriveMissingPaperRows sorts by series code, then year, then
  // subject).
  const groups: { examSeriesCode: string; examSeriesName: string; rows: MissingPaperRow[] }[] = [];
  for (const row of rows) {
    let group = groups[groups.length - 1];
    if (!group || group.examSeriesCode !== row.examSeriesCode) {
      group = { examSeriesCode: row.examSeriesCode, examSeriesName: row.examSeriesName, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }

  return (
    <>
      <h1>Missing papers</h1>

      <div className="callout">
        <p>
          <strong>We do not have these papers yet.</strong> If you have a
          copy of one, please send it to us.
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="empty-state">No known gaps right now — everything tracked has been recovered.</p>
      ) : (
        groups.map((group) => (
          <div key={group.examSeriesCode} style={{ marginTop: "2rem" }}>
            <h2>{seriesDisplayLabel(group.examSeriesCode)}</h2>
            <div className="data-table table-scroll">
              <table>
                <caption className="visually-hidden">
                  Missing papers for {seriesDisplayLabel(group.examSeriesCode)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Year</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Missing</th>
                    <th scope="col">
                      <span className="visually-hidden">Contribute</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.examSeriesCode}-${row.year}-${row.subjectSlug}`}>
                      <td data-label="Year">{row.year}</td>
                      <td data-label="Subject">{row.subjectName}</td>
                      <td data-label="Missing">
                        {/* One wrapper, so on a phone the badges wrap inside the
                            card (see .badge-list in globals.css). */}
                        <span className="badge-list">
                          {row.missingArtifactTypes.map((type) => (
                            <Badge key={type} tone="neutral">
                              {artifactTypeLabel(type)}
                            </Badge>
                          ))}
                        </span>
                      </td>
                      <td>
                        <a
                          className="table-action"
                          href={mailtoHref(row)}
                        >
                          <MailIcon />
                          {/* The accessible name starts with the visible words, so
                              "click Send it" works with voice control. */}
                          Send it
                          <span className="visually-hidden">{`: ${row.subjectName} ${row.year} (${seriesDisplayLabel(row.examSeriesCode)})`}</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </>
  );
}
