# Search audit gap journeys

The three reports describe earlier source boundaries. At retained base
`683638d2c18047d3f389f25c68dda8dba9738dd5`, their Search-owned gaps already have integrated
journeys. The mapping below assigns those rows to that work rather than issuing duplicate
continuations. Integration acceptance remains with the controller; this mapping is not a new
native, browser or growth acceptance result.

Decision: map each report row to its Search-owned slice of retained integrated work; create no
duplicate journey and leave explicitly deferred scope closed.

## Premises and existing work

`bun tools/goal/src/cli.ts status` did not support the premise that every worker was idle:
it reported running, ready and held tasks. Search had this planning assignment and the running
OpenSearch analyzer/setup assignment. That setup assignment concerns development setup and
bounded sort keys, not the catalogue-result journeys below. No Search task was ready or held.

The integrated tasks below are present in the retained source and in `git log dev`. Commit
references identify their retained delivery; task identities are in this change's commit message.
An integrated task's existence alone does not establish that its deferred acceptance passed.

| Existing integrated task                    | Retained delivery                     | Journey covered                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute native five-kind mixed discovery    | `1bbf76e600a6`                        | One query and continuation return Subjects, Accounts, public Collections, reviews and Spaces, with current hydration, deterministic full-key identity and honest unavailable counts.                                                              |
| Install complete mixed producer generations | `2a83655ab229`                        | Default registration, native owner adapters and complete common-generation publication supply the public metadata kinds; incomplete owner coverage remains explicit readiness.                                                                    |
| Render public mixed result kinds            | `b7c839004d2d`                        | The installed web reader and rows admit the closed variants, retain native order and current context, and use canonical destinations.                                                                                                             |
| Complete rich mixed discovery cards         | `a7a2c1e8a613` through `7eefd9c122f2` | Current descriptions, type-aware facts, supported public figures and a bounded private viewer envelope survive API projection and the web reader.                                                                                                 |
| Install live mixed Search personal actions  | `73644dd91452` through `8a91e3701e24` | Native entry and question-bound score actions operate from admitted result state, with bounded capability reads, reconciliation, reader retirement and keyboard recovery. This completes the earlier controlled-entry and viewer-authority tasks. |

## Row mapping

### Page needs, API and rendering audit

Source: [page-needs-api-render-audit](page-needs-api-render-audit.md).
Repeated appearances of a gap identify affected pages, not separate journeys.

| Open report row                                                                                                                                                                         | Search responsibility                                                                                                                                                                                                             | Existing task assignment                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A03**, Home: discover public Collections, reviews and Spaces; Space: discover the Space from Home or mixed search; Search results: return those actual result kinds; ranked API gap 5 | Register and execute the owner-supplied public kinds, serialize their closed summaries, and preserve current admission through continuation. Content owns Home composition; Library and Community retain their owner disclosures. | Execute native five-kind mixed discovery + install complete mixed producer generations + render public mixed result kinds. No new Search brief.                                                         |
| **A06**, Search results: distinguish similarly named catalogue rows by description, creator/date facts and public figure; ranked API gap 7                                              | Carry bounded type-aware comparison facts through mixed semantic hits and reuse their result presentation. The Library/Collection projection portion remains Library's responsibility.                                            | Complete rich mixed discovery cards. No new Search brief.                                                                                                                                               |
| **A05**, Search results: see my entry/score and save or change it in place; ranked API gap 3's discovery portion                                                                        | Consume the owner-authorized private page envelope and native commands without putting viewer state in public Search data. Library owns entry/score composition and shelf ordering; Content owns ratings.                         | Complete rich mixed discovery cards + install live mixed Search personal actions. Included as a Search dependency even though the ranked row assigns primary ownership to Library. No new Search brief. |

The audit's **I04** Realm/Space catalogue handoff is assigned to Web, and its Search APIs are
already described as available. It does not create a Search journey. **A05** personal-score
shelf sorting and **A06** generic Library/Collection summaries are not claimed complete by
this Search mapping.

### Web component parity

Source: [web-component-parity](web-component-parity.md).
There is no open row assigned to Search. Its delivered/reserved component table assigns
feed, shell, replies, composer, selection and generic tagging to their existing owners.
The reserved generic tagging capability does not become a Search ballot or concept-browse
assignment. The report's rendered-review boundary remains with integration.

### API-first reference platform coverage

Source: [api-first-platform-coverage](api-first-platform-coverage.md).
There is no open row assigned to Search. **Q** and **W9** describe the existing search API
and route. The shared-capability row explicitly classifies advanced facets/scopes/rating
sorts, saved dynamic queries and personalized recommendations as deferred or scope-gated;
the closing scope boundary repeats that these are not launch gaps.

Rank 8's optional graph, quotation and domain browsing has no Search assignment and calls
for a concrete reader task before adding surfaces. Existing finite relation/credit/appearance
lists satisfy its basic reading criterion. Ranks 1–7 and 9 describe portability, progress,
domain configuration, ballots/statistics, occurrence semantics and integrations, rather than
an additional approved Search-owned journey. None warrants manufacturing a duplicate Search
brief from a platform name.

## Retained implementation and delivery boundary

The [default discovery composition](../../services/kernel/src/search/default-discovery.ts)
installs native Collection/review/Space seams and assembles current presentation facts,
public figures and private viewer facts. The
[closed HTTP projection](../../services/kernel/src/search/discovery-http.ts) admits all five
result variants, carries descriptions/facts/figures, and serializes the private envelope.
These replace the thin subject/account-only boundary cited by A03 and A06.

The [public result and personal-action owner](../../apps/web/src/search/discovery-public-results.md)
describes the mounted mixed-result host, native actions, no-store private assembly, honest
unavailable states and finite per-page/command costs. Its controlled personal-action section
records the later installed host; the earlier distinction between public summaries and a
private reader seam still applies. Growth and browser acceptance remain separate from source
installation.

There are zero uncovered Search-owned journeys in these three reports and therefore zero
new continuation briefs. The requested 2,000–3,000-line implementation sizing, Cost sections
and engine growth checks apply when a new journey is needed; they do not justify duplicating
these integrated tasks. No product code, tests or stories change in this planning assignment.
