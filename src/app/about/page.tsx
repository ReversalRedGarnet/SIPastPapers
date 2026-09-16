import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
};

export default function AboutPage() {
  return (
    <>
      <h1>About this project</h1>

      <h2>Purpose</h2>
      <p>
        The SI National Exam Archive is a free, open-source archive of
        Solomon Islands national exam papers, preserving material otherwise
        scattered across Ministry pages, schools, teachers, and
        document-sharing sites. It does not create new exam content or
        provide access to unreleased exams.
      </p>

      <h2>Ownership and independence</h2>
      <p>
        This project is independent, with no MEHRD affiliation or
        endorsement unless explicitly granted. Infrastructure (repo, domain,
        hosting, storage) is intended to stay project-owned, not tied to any
        one individual&apos;s personal account.
      </p>

      <h2>Open source</h2>
      <p>
        Code is released under a permissive license (MIT/Apache-2.0),
        covering the codebase only — not rights to archived exam content,
        which is tracked separately.
      </p>

      <h2 id="corrections">Correction and takedown process</h2>
      <ol>
        <li>A report is received and the affected record is identified.</li>
        <li>
          If the report plausibly concerns ownership, privacy, security or
          authenticity, the record is placed on rights hold pending review.
        </li>
        <li>
          Provenance and rights evidence are reviewed, and the relevant
          rights holder is contacted where needed.
        </li>
        <li>
          The record is resolved: retained, corrected, replaced, restricted,
          or withdrawn.
        </li>
        <li>The final decision, evidence and date are logged.</li>
      </ol>
      <p>
        The &quot;report a problem&quot; link on every paper page feeds
        directly into this process. Formal contact channels for
        institutions and contributors are not set up yet.
      </p>

      <p className="hint">
        This project is run by A.D. Orihao. For any queries, issues, or
        corrections, contact{" "}
        <a href="mailto:dorihaop@gmail.com">dorihaop@gmail.com</a>.
      </p>
    </>
  );
}
