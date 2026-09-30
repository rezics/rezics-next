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

- **Holder-provided compute.** An independent open-source toolkit (a CLI, an MCP
  server and agent skills) runs on the holder's machine with the holder's own
  agent and submits through the
  [open contribution protocol](skills-and-prompts.md#open-agent-contribution-protocol).
  REZICS supplies protocol, evidence and review; the holder's agent extracts.
- **Text stays local.** Full text never leaves the holder's machine, and the
  toolkit circumvents no DRM. A proposal carries extracted characters, aliases,
  relationships, events and places, each with a chapter locator and a short
  quotation as evidence.
- **Matching is a proposal.** The toolkit matches extractions to existing
  entities through the API; a proposed equivalence is reviewed like any other
  claim, never merged silently.
- **The wiki is a Zone over graph facts.** Reviewed bundles publish into the
  Work's wiki Zone, a [routed site](../product/platform-thesis.md#zones-are-routed-sites)
  with character, location, timeline, chapter-guide and relationship pages,
  read at each reader's spoiler position. Its infoboxes and lists are the same
  records that filters, lists and other Zones read, so a correction in one wiki
  improves every view of that fact.
- **The Work page stays the hub.** It shows the wiki's summary beside ratings,
  reviews, library status, discussion, relations and lists; the wiki Zone is its
  deep end, not a replacement.

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
