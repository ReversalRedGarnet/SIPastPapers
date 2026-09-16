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
        The SI National Exam Archive is a free, searchable, open-source
        historical archive of Solomon Islands national examination papers
        and associated materials. It exists to preserve and make
        discoverable historical assessment material that is otherwise
        fragmented across Ministry pages, schools, teachers, former
        students and document-sharing sites. It is not intended to create
        new exam content or provide access to unreleased examinations.
      </p>

      <h2>Who it&apos;s for</h2>
      <p>
        The archive is built primarily for students preparing for Solomon
        Islands national exams, so they can revise using real past papers
        similar to the ones they&apos;ll actually sit. It&apos;s also useful
        to teachers, researchers, and anyone else who wants access to this
        historical assessment material.
      </p>

      <h2>Status</h2>
      <p>
        This site is in early development. The database, search and
        browsing pages are functional, and real historical exam papers are
        being ingested and published through a local admin CLI. Coverage is
        still partial — more exam levels, years and subjects are added
        incrementally as they are recovered and verified, not all at once.
      </p>

      {/*
        PLACEHOLDER — revisit after the upcoming meeting with exam
        officials. The verification description below reflects only the
        teacher-verified network that's actually in use today (see
        PROJECT_SPEC.md's rights-basis notes and the homepage copy) — do
        not add or imply any official/Ministry (MEHRD) verification,
        endorsement, or involvement here until that's explicitly
        confirmed. Update this section once sourcing/verification
        arrangements from that meeting are settled.
      */}
      <h2>How papers are verified</h2>
      <p>
        Most papers in the archive are verified through a personal network
        of teachers, education officers and former students who confirm a
        paper&apos;s authenticity and provenance before it&apos;s
        published — the same verification approach described on the
        homepage. These verification and sourcing arrangements may be
        updated as new relationships with schools and officials are
        formalized, and this page will be revised to reflect that when it
        happens.
      </p>

      <h2>Ownership and independence</h2>
      <p>
        This project is independent and is not affiliated with or endorsed
        by the Ministry of Education and Human Resource Development
        (MEHRD) unless MEHRD has explicitly granted endorsement. Project
        infrastructure — repository, domain, hosting, database and object
        storage — is intended to remain under project-owned control rather
        than any single individual&apos;s personal account.
      </p>

      <h2>Open source</h2>
      <p>
        The codebase is intended to be released under a permissive license
        (such as MIT or Apache-2.0). That software license applies only to
        the code — it does not grant any rights in third-party or
        Government-owned examination content. The licensing and rights
        status of archived documents is tracked separately from the
        software license.
      </p>

      {/*
        PLACEHOLDER — same follow-up as the "How papers are verified"
        section above: revisit this rights-basis language after the
        exam-officials meeting, and don't add ministry/MEHRD claims here
        until confirmed.
      */}
      <h2>Rights statement</h2>
      <p>
        Every document eventually published on this site will identify its
        rights holder where known, record the basis on which it is hosted
        (e.g. written permission, or public domain / expired restriction),
        and carry a source and attribution note. No document is published
        without a resolved rights status.
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

      <p className="hint">Built and maintained by A.D. Orihao</p>
      <p className="hint">
        Questions or corrections: <a href="mailto:dorihaop@gmail.com">dorihaop@gmail.com</a>
      </p>
    </>
  );
}
