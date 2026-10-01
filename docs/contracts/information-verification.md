# Claims, evidence and information verification

Status: source lineage, claim analysis and bounded summaries have owner slices;
general verdict, quality-query and campaign qualification remain prospective.
[FACT01–06](../../scripts/qa/cases/information-verification.ts) retain their
existing evidence; added combinations remain explicitly pending.

## Model

A claim is a precise proposition with referent, context, edition and valid time.
Provenance describes observations and derivation; source reliability applies to a
domain/context; claim support evaluates exact evidence; acceptance selects a result
in an owning context. None substitutes for another. Protection remains an
independent [editorial decision](editorial-protection.md): a lock does not verify a
claim, and a quality change does not authorize replacing adopted content.

## Quality dimensions and records

The [owner schema](../../services/main/src/modules/verification/schema.ts) binds
lineage, evidence-set revisions, dispositions, challenges, summary generations,
dependency heads and invalidation effects; graph claims and assessments remain
exact owner records. Preserve source availability, qualification, review, dispute,
coverage and freshness separately. Reviewed and disputed can coexist. Unknown
dependence is not independent support; a missing payload or stale assessment is
not a negative verdict. Public provenance cannot expose private source bytes or
principal/control identities. Ordinary scalar values need no preallocated quality
record. RDF 1.1 is the admitted exchange profile; RDF 1.2 is a later choice.

## Workflow and methods

Acquire, propose, resolve, assess, review/adopt, then publish. AI output records
inputs and method and cannot grant itself authority on re-ingestion. Methods need
declared applicability, cost, coverage and held-out calibration. A challenge is
pending until qualified assessment; withdrawal removes only that source's support.
Preserve exact older assessments and independent support. Editorial confirmation
does not clear [source rights](source-lifecycle.md).

## Summary policy and freshness

The [analysis](../../services/main/src/modules/verification/analysis.ts) abstains
on incomplete, circular or over-budget lineage. A versioned summary retains
support, review, dispute, coverage, dependence, reason codes and exact dependency
positions. Activation checks heads atomically; reads cannot call a queued old
summary current merely because invalidation delivery lags. Paginate reverse
dependency work with resumable cursors; never label a truncated prefix complete.
Scores are method output with calibration limits, not bare fact probabilities.
Restored summaries require reconciled withdrawal, authority and erasure frontiers.

## Planned API and cost contracts

Claims, evidence, source assessments, claim assessments, challenges and quality
queries require exact mutable-head expectations, idempotency, Access/disclosure and
bounded work. An omitted head differs from explicit absence. Reject over-budget
input without partial adoption; resolve uncertain commits by receipt. Keep external
fetch and model evaluation outside the Jena writer. Scalar evidence/rating ceilings
are 32 each; ordinary pages and quality queries cap at 50 targets, with separate
dependency and byte budgets. Large campaigns need complete staged manifests and
engine-plan, writer-time, queue-lag and cold/skewed-read qualification.

## Activation and boundaries

Method evaluations must report held-out errors, calibration, coverage and
abstention; deterministic policy tests alone cannot qualify a method. Exports
retain exact policy, provenance, uncertainty and disclosure losses. Funding and
subscription status cannot buy a verdict. Untrusted source/tool content stays data.

## Knowledge workspace

Decision 23, product manager under maintainer delegation, 2026-09-29.
Realm wikis combine multilingual addresses, citations, graph infoboxes, links and
backlinks, discussion, review, watch, exact history/diff/restore and export.
Saved list/table/gallery views over Collections and filters, plus private reading
notes, make the knowledge useful beyond article reading. [MediaWiki page history](https://www.mediawiki.org/wiki/Help:History)
and [Notion views](https://developers.notion.com/guides/data-apis/working-with-views)
are precedents for inspectable knowledge and reusable organization; the reason
to compose existing owners is to preserve one identity and disclosure policy.

## A big-franchise wiki for every Work

Decision 29, product manager under maintainer delegation, 2026-09-29.
Build sourced, position-aware knowledge: fictional entities, chapter-evidenced
claims, multilingual names/aliases, and event time separate from revelation
position. Agents propose chapter-by-chapter facts and structure from licensed,
public-domain or author-supplied text and structured dumps. Reviewers publish
coherent bundles and new-chapter deltas; nothing reaches readers without human
review, and readers see only what their consumption position admits.

Maintainer, 2026-09-30: building the wiki is one action, and the wiki is the
flagship; the [goal](../product/goal.md#wiki-the-flagship) describes the flow and
the wiki+ positioning. The rules it relies on:

- **A thin, neutral toolkit; the platform does the work.** Maintainer,
  2026-09-30. Three layers, heaviest first: REZICS's API and remote MCP server
  (evidence, candidate lookup, proposal bundles, publication, status, and every
  platform rule such as schema, quotation limits and idempotency); an agent
  skill following the [Agent Skills](https://agentskills.io/specification)
  specification that teaches any agent to segment, extract atomic evidenced
  claims, check for duplicates and submit deltas; and a small package for what
  models do unreliably, namely exact locators and plain-text conversion through
  existing libraries. Other formats come from existing projects or community
  modules. The package is published from this repository as an independent
  Apache-2.0 package that imports no AGPL code; the protocol schemas it uses are
  published under Apache-2.0 too. It works with any compatible server, needs
  no REZICS account, sends no telemetry and fetches nothing on its own.
- **No judgement, no circumvention.** The toolkit does not investigate where
  input came from or whether it was once encrypted; it contains no decryption,
  key recovery, licence or disc-check bypass or protected-player hooks, and it
  never falls back to such tools, so protected input simply fails to parse. Its
  releases and documentation never ship, curate or recommend circumvention
  plugins or bypass recipes, and examples use public-domain, own or licensed
  works. This follows the anti-trafficking rules of
  [17 USC §1201](https://www.copyright.gov/title17/92chap12.html#1201), Japan's
  Copyright Act Article 120-2 and InfoSoc Article 6, and the inducement line in
  [Grokster](https://www.law.cornell.edu/supremecourt/text/04-480) and
  [Cox v. Sony (2026)](https://www.supremecourt.gov/opinions/25pdf/24-171_bq7d.pdf).
  Neutrality is a separation of responsibilities, not a copyright guarantee,
  and REZICS never presents it as deliberate ignorance. The first version reads
  TXT, EPUB 2/3 and literal Ren'Py scripts and never executes embedded script
  code.
- **REZICS never receives the full text.** A cloud agent sends what it reads to
  its model provider, which is the holder's choice; a local model keeps it on
  the machine. REZICS-operated agents never receive holders' corpora, retrieval
  access or full-text embeddings, only approved records. A proposal carries
  characters, aliases, relationships, events and places, each with a locator
  and a short quotation.
- **Publication policy lives in the API.** Fictional details are not presumed
  free facts ([Castle Rock](https://law.justia.com/cases/federal/appellate-courts/F3/150/132/571410/),
  [Warner Bros. v. RDR Books](https://www.copyright.gov/fair-use/summaries/warnerbros-rdrbooks-sdny2008.pdf)),
  so Main enforces versioned per-passage and cumulative per-source quotation
  budgets across accounts, translations and Zones, and review watches close
  paraphrase and cumulative story coverage. Rights and removal decisions follow
  records into every Zone, search result, history and export.
- **Verifiable locators.** TXT uses a representation hash and original byte
  range; EPUB uses a range [EPUB CFI](https://idpf.org/epub/linking/cfi/) with a
  quote fallback; visual-novel scripts use script hash, label and utterance
  position with route guards. A reviewer holding the same edition verifies the
  passage locally; changed editions need explicit alignment.
- **Matching is a proposal.** The toolkit retrieves candidates through the API
  and reports each extraction as matched, new, ambiguous or unavailable; a
  proposed equivalence is reviewed like any other claim, never merged
  silently, and new chapters produce deltas that never silently delete accepted
  claims.
- **The wiki is a Zone over graph facts.** Reviewed bundles publish into the
  Work's wiki Zone, a [routed site](../product/platform-thesis.md#zones-are-routed-sites)
  with character, location, timeline, chapter-guide and relationship pages,
  read at each reader's spoiler position. Its infoboxes and lists are the same
  records that filters, lists and other Zones read, so a correction in one wiki
  improves every view of that fact.
- **Readers choose how far to see.** Anonymous readers start before the first
  revelation. Signed-in readers default to their own furthest completed
  occurrence; a Library status of `read` counts as finishing that Work. Anyone
  may choose an occurrence or show everything with `position=all`. A position
  applies only within its continuity; unrelated or unreadable continuities
  withhold their affected records without suppressing the rest of the page.
  Records without a revelation position keep their existing disclosure rules.
- **The Work page stays the hub.** It shows the wiki's summary beside ratings,
  reviews, library status, discussion, relations and lists; the wiki Zone is its
  deep end, not a replacement.

External-text evidence, reviewed bundle publication, dependency outcomes and
revelation positions now share the existing proposal and owner-command lifecycle.
What remains missing (R51) is bounded chapter-delta reconciliation and its MCP
bindings. The first editorial benchmark still needs one Work with two language
editions, a wiki Zone and a chapter update, measured in editor minutes per accepted
claim against manual work at equal quality.

Each Realm decides whether agents may draft and whether generated prose is
permitted. Facts and structure are the default because fluent prose can hide
invented citations. [Wookieepedia sourcing](https://starwars.fandom.com/wiki/Wookieepedia%3ASourcing)
and [Coppermind spoiler guidance](https://coppermind.net/wiki/Help%3ASpoilers)
show the editorial and revelation boundaries; [BookWorm](https://arxiv.org/abs/2410.10372)
supports investigating retrieval but does not prove complete or accurate wikis.

Start with entity indexes, concise articles, infoboxes, navboxes, chapter guides,
appearances, relationship lists, basic timelines, citations and backlinks.
Family trees, adaptation alignment, world maps and chronologies follow.
Completeness means coverage of an identified corpus, never page count. The
[agent contribution owner](skills-and-prompts.md#open-agent-contribution-protocol)
supplies the common review boundary for holder-provided compute.
