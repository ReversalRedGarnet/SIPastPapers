import type { Metadata } from "next";
import { getCoverageMatrix } from "@/lib/db/queries";
import { deriveMissingPaperRows, type MissingPaperRow } from "@/lib/missing-papers";
import { seriesDisplayLabel } from "@/lib/format";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Missing papers",
  description:
    "Every past Solomon Islands national exam paper we know about but don't have a copy of yet. Have one? Email it in.",
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
      <p className="lede">
        These are papers the archive knows should exist but doesn&apos;t have a
        copy of yet — some were never recovered, some just haven&apos;t been
        acquired for that year at all. Nothing here is fabricated or
        guessed; each row is a real gap tracked in the archive itself.
      </p>
      <p className="lede">
        Have one of these? Email it to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

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
                    <th scope="col">What&apos;s missing</th>
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
                      <td data-label="What's missing">{row.missingTypes.join(" + ")}</td>
                      <td>
                        <a href={mailtoHref(row)}>Have this one? Email it to {CONTACT_EMAIL}</a>
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
