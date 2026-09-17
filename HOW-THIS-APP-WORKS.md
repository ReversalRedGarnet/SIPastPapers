# How This App Works

This document is for someone who has never built a website before — you
don't need to know JavaScript, TypeScript, SQL, or Next.js to follow it.
Where a technical word is unavoidable, it's explained in plain terms the
first time it shows up, and again in the glossary at the end.

## What this app actually does

This is a website that lets people search for, browse, and download old
national exam papers from the Solomon Islands — things like a Form 3 Maths
paper from 2019, or a Form 5 English paper from 2021. A visitor can type a
search term, or click through menus (pick an exam level, then a year, then
a subject) to find a paper, then view it in their browser or download the
PDF. Nothing on the site requires an account or a password — anyone can
browse and download for free. Behind the scenes, someone (the person who
runs the archive) has to add each paper to the system before it shows up,
which is done separately from the website itself (more on that below).

## The big moving pieces

There are four main pieces, and understanding how they connect is most of
what you need to understand this whole project.

```
                     ┌─────────────────────────┐
                     │   A visitor's browser    │
                     └────────────┬─────────────┘
                                  │ visits a page, e.g. "/results"
                                  ▼
                     ┌─────────────────────────┐
                     │     The website          │
                     │  (built with Next.js)    │
                     └──────┬──────────┬────────┘
                             │          │
              reads/writes   │          │ reads/writes
              records about  │          │ the actual PDF
              papers         ▼          ▼ files
                     ┌───────────┐  ┌───────────────┐
                     │ The       │  │ File storage   │
                     │ database  │  │ (PDFs live     │
                     │ (Postgres)│  │  here)         │
                     └───────────┘  └───────────────┘
                             ▲
                             │ adds/updates records
                             │ (never through the website)
                     ┌───────────────────────────┐
                     │  The command-line tool     │
                     │  (run by the archive       │
                     │   operator on their own    │
                     │   computer)                │
                     └────────────────────────────┘
```

- **The website** is what a visitor sees and clicks around in — the
  homepage, the search page, the browse pages, and each individual paper's
  page. It doesn't store anything itself; every time it needs to show a
  list of papers, or a single paper's details, it asks the database for
  that information.
- **The database** is where all the *information about* each paper lives:
  its year, subject, exam level, title, whether it's actually available
  yet, and so on. Think of it as a very large, very organized set of
  spreadsheets that are linked together (a "Mathematics" row can be linked
  to a "2019" row, which can be linked to a "SISC Level 1" row, and so on).
  The database does **not** store the PDF files themselves — just the
  facts about them.
- **File storage** is where the actual PDF files live — either on the same
  computer's disk (for a developer working locally) or in a cloud storage
  service called Cloudflare R2 (for the real, published website). When
  someone downloads a paper, the website fetches the actual file bytes
  from here, not from the database.
- **The command-line tool** (often called "the CLI", short for
  "command-line interface") is a separate program that only the person
  running the archive uses, from their own computer, by typing commands
  instead of clicking buttons. It's the *only* way new papers get added,
  approved, or published — a visitor to the website can never do any of
  that.

## What the database is doing here, and why there's a separate command-line tool

A database is just a very reliable, very organized way to store
information so it can be searched and filtered quickly and never gets
mixed up or lost. Every time the website shows you "12 Mathematics papers
found," it's really asking the database a question ("give me every paper
where the subject is Mathematics") and showing you the answer.

You might expect a site like this to have an "admin" section of the
website itself — log in, click a button, upload a file. This project
deliberately does **not** work that way. Adding a paper to the archive
involves a real decision with real consequences: is this paper allowed to
be published? Has someone verified it's genuine and not from the wrong
year? Those questions matter enough that this project keeps them as a
separate, deliberate step done by one trusted person on their own
computer, using the command-line tool — never as a "click a button on the
public website" action that could be automated, rushed, or done by mistake.
This also means the public website never needs a login system or an admin
password at all, which removes an entire category of security risk: there
is simply no door on the website for an outsider to try to break into.

## What a "route" or "page" is in this project

When you type a web address like `https://example.com/browse`, the part
after the domain name (`/browse`) tells the website which page to show
you. In this project, each of those addresses is called a **route**, and
almost every route corresponds to one file that decides what to draw on
the screen for that address. For example, the file that handles the
`/results` address is what generates the search page you see when you
visit it. Some routes have parts that change — like `/browse/sisc-l1/2019`
— where "sisc-l1" and "2019" are filled in depending on what the visitor
clicked; those show up in the project's folders as names in square
brackets, like `[series]` or `[year]`, which just mean "this part of the
address can be anything, and whatever it is gets handed to the page."

A handful of routes aren't pages at all — they don't return anything to
look at, just raw data or a file. Those are used for things like
downloading a PDF, or generating a zip file of every paper for one year.

## Where to start reading the code

If you want to understand this codebase, don't start with the biggest or
most important-looking file — start with the smallest, simplest ones and
work outward. A sensible order:

1. **`src/lib/format.ts`** — tiny, self-contained functions that turn raw
   data into something readable (like turning a number of bytes into
   "2.3 MB"). No database, no web page, just plain logic. The gentlest
   possible starting point.
2. **`src/lib/browse-years.ts`** and **`src/lib/artifact-naming.ts`** —
   similarly small, plain-logic files with no moving parts outside
   themselves.
3. **`src/types/domain.ts`** — this doesn't *do* anything by itself; it
   just describes the *shape* of the data used throughout the app (what
   fields an exam series has, what fields a subject has). Reading it gives
   you a map of the vocabulary the rest of the code uses.
4. **`src/app/page.tsx`** — the homepage. This is a good first real "page"
   file to read, since it's one of the shorter ones and shows the basic
   pattern every page follows: ask the database for some data, then
   describe what to draw on the screen with that data.
5. **`src/app/results/page.tsx`** — the search page. A bit more involved
   than the homepage (it has a form, filters, and pagination), but follows
   the same basic pattern.
6. **`src/lib/db/queries.ts`** — the biggest and most important file in
   the project. Every question the website ever asks the database goes
   through a function in this one file. It's long, but each function is
   fairly self-contained, and the comments explain what each one is for.
7. **`src/lib/storage/`** (three files: `types.ts`, `local-fs.ts`,
   `r2.ts`) — how the actual PDF files get read and written, in two
   different ways (your own computer's disk, or the cloud), behind one
   shared interface.
8. **`scripts/cli.ts`** and **`scripts/cli-lib.ts`** — the command-line
   tool the archive operator uses. Read this after everything above, since
   it uses most of the pieces you'll have already seen.

## Glossary

Plain-English, one-sentence definitions for technical words used in this
project's code and comments.

- **API route** — a web address that returns raw data or a file instead of
  a page to look at; short for "Application Programming Interface."
- **Async / await** — a way of writing code that has to wait for something
  slow (like asking the database a question) without freezing the whole
  program while it waits.
- **Cache** — a temporary copy of an answer, kept nearby so the next time
  the same question is asked, the program can reuse the copy instead of
  doing all the slow work again.
- **CLI (command-line interface)** — a program you interact with by typing
  text commands, rather than clicking buttons in a window.
- **Component** — a reusable, named chunk of a web page's design, like "the
  search box" or "the site's footer," that can be reused across multiple
  pages.
- **Database** — an organized system for storing information so it can be
  reliably searched, filtered, and updated.
- **Environment variable** — a small piece of configuration (like a
  password or a web address) that's set outside the code itself, so the
  same code can behave differently on different computers without editing
  it.
- **Function** — a named, reusable block of instructions that can be run
  whenever it's needed, optionally given some information to work with and
  optionally handing back a result.
- **Hook** — in React (see below), a special kind of function that lets a
  page "hook into" some extra ability, like remembering which web address
  the visitor is currently on.
- **Import / export** — how one file in the code says "I want to use
  something defined in that other file" (import) and how a file says
  "here's something other files are allowed to use" (export).
- **Interface / type** — a description of exactly what pieces of
  information something is made of (for example, "a Subject always has a
  name and an ID"), used so mistakes get caught before the program even
  runs.
- **JSX** — a way of writing what a web page should look like directly
  inside the same file as the program logic, so instructions like "if
  there are no results, show this message instead" sit right next to the
  actual layout.
- **Next.js** — the framework (pre-built toolkit) this website is built
  with; it handles turning a folder of files into a working website with
  addresses/routes, without the project having to build that machinery
  from scratch.
- **Parameterized query** — a way of asking the database a question that
  keeps user-typed text safely separate from the question itself, so a
  visitor can never trick the database into doing something unintended by
  typing something clever into a search box.
- **React** — the underlying library Next.js is built on, responsible for
  describing what a page should look like based on the current data.
- **Route** — a specific web address (like `/browse` or `/results`) and
  the file in this project responsible for what shows up there.
- **Route parameters** (`params`) — the changeable parts of a web address
  itself, like the "2019" in `/browse/sisc-l1/2019`.
- **Query parameters** (`searchParams`) — extra information added to the
  end of a web address after a `?`, like `?q=maths`, usually from a search
  box or a filter.
- **Server vs. client component** — a "server" piece of the page is built
  on the website's own computer before it's sent to the visitor (and can
  safely talk to the database); a "client" piece is small bit of code that
  actually runs in the visitor's own browser, usually because it needs to
  react to something the visitor does, like a click.
- **SQL** — the language used to ask a relational database (like the
  Postgres database this project uses) questions, such as "give me every
  row where the subject is Mathematics."
- **Storage** — the place actual files (like PDFs) are physically kept, as
  opposed to the database, which only keeps facts about those files.
- **Transaction** — a group of database changes that are made to happen
  together as a single all-or-nothing unit, so if one part fails, none of
  the changes are kept, and the data never ends up half-updated.
