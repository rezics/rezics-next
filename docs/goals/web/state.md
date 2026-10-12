# State

The checkpoint for [this Goal](GOAL.md). Not started; written on 2026-10-12 from
the launch manager's end-of-run table, archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-12) |
| --- | --- |
| Manager | None. The program starts one when the first vertical's rows are proved |
| Rows | 67 in scope; 44 have a browser proof, 23 have none. The Gutenberg recipes row was proved through the importing author's view only |
| Shared stack | The web hot-reloads from the main checkout; the backend is the revision of the last refresh (the program's state file names it) |

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`.
Each item becomes a surface task after its row is proved through the API, or is
dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Visual novel hub and release choice (`g-2035`) | Its API proof and the phone and desktop journey passed; the last review left one P1: the shared preference form erases a valid retained release pin when the release's languages change in a later revision | Compare the pin against its own edition revision; the registry row stays unproved until it lands |
| Games: platform scheme, facts and facets (`g-1855`) | Stopped before its handoff; an earlier review left a P1 | Rerun its integration and journey on `main`; a genre can still show among the platforms |
| Recipe one-button publish and the editor's native ingredient rules (`g-1961`) | Integration and the publish journey passed; the gate is red on a coverage declaration that names an old test title; the commits after its first review were never reviewed | Fix the declaration, review, land. The recipe reader still flattens sections |
| Library lists continue in place; one Access-plus-disclosure shelf reader (`g-2048`) | Its reads pass; the gate is red because the new shelf read is not in the hidden-id inventory | Register it and land: until then the shelf directory on `main` can show a private shelf's name after its access was closed. Six further groups (Home Continue, tracking, ratings, Discover and invitations, the managed rail and attached Zones) were never started |
| A saved release filter keeps its choices (`g-2055`) | One P1: applying a held URL with a retired facet still drops that choice | Fix or drop |
| Recipe export and import round trip (`g-1987`) | A test commit only | Route sections at the root, a partial import restarting, export importability unused in the interface |
| Zone home document identity | On `main`; two commits after its last review are unreviewed | The joint authority and disclosure fence race is a named expected failure; the discussion and browser proofs were not made |
| Realm write isolation and closure acceptance | Steps on `main` | The Realm browser journeys; the closure notification store was never built |
| Public hub parts and relations | On `main`; the relation link was fixed after the journey last failed | Rerun the journey |
| Gutenberg recipes | 30 Works on the shared stack at `/en/z/launch-recipes/browse`; readers see the text only | Structure waits for the decision 55 design in the [api](../api/state.md) Goal; ten Italian recipes have no recognised amounts |
| Search page "at least N" and the tests under the disclosure contract | Briefs only | Wait for the api Goal's search work |

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
