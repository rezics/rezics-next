# State

The checkpoint for [this Goal](GOAL.md). Not started; written on 2026-10-12 from
the launch manager's end-of-run table, archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-12) |
| --- | --- |
| Manager | None. The program starts one when the first vertical's rows are proved |
| Rows | 67 in scope; 44 have a browser proof, 23 have none |
| Shared stack | The web hot-reloads from the main checkout; the backend is the revision of the last refresh (the program's state file names it) |

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`.
Each item becomes a surface task after its row is proved through the API, or is
dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| (the launch manager's end-of-run table is filed here in the commit that closes its Goal) | | |

## Known on main

- Related-Work links carry canonical addresses with readable suffixes since
  2026-10-12. Two browser tests (`g-841-q04-reboot-spinoff`, `g-841-q03-identity`)
  and one story (`entity-page.stories.tsx`) still expect bare-identity hrefs and
  fail; the anime pointer case runs on a Book-typed fixture, and part and whole
  links are not clicked in any test.
- Anime and manga browse one year at a time through the API; the "all years"
  list still stops after a few pages.
- Home "Continue" shows six items and followed authors eight, with no "see all".
- A journey's setup fails on the QA profile ("Safety responders are not
  configured", "Work name scope is not prepared"); the profile lacks a
  preparation, which is the program's to fix.

## What the web got wrong on 2026-10-12

Every defect was the client not following the API's contract. They are the
rules a surface task checks, in the client or by a guard:

| Class | Example |
| --- | --- |
| A continuation dropped or invented | Import review rows built later cursors by arithmetic (a guard refuses it now); capped lists with no way to the rest |
| `202` shown as done | A moderator saw content as removed while its effects were pending |
| A read sent without the acting identity | A private Realm's member could not read its decisions |
| A filter applied in the client over a capped page | Year browse lost eligible Works |
| A stored draft outliving its basis | Realm rule drafts overwrote another moderator's publication; drafts now live in the page only |
