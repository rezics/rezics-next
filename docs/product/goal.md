# REZICS goal

Maintainer and product manager, 2026-09-30, after research round R40–R50. This
page states what REZICS is for and how its success is judged. The
[platform thesis](platform-thesis.md) explains how one engine delivers it;
[markets and growth](markets-and-growth.md) owns launch order and revenue.

## Mission

REZICS is one open, multilingual platform where people discover, organize,
discuss, create and distribute what they care about. Every work, person,
organization, place, event and model has one identity in one shared graph, and
any community can build a complete site on that graph. Each contribution
therefore improves every other community's experience.

The promise to users: **discover what connects, keep your library together, and
follow works and creators wherever they lead.**

The long-term goal is that one platform natively solves most of what people do
around the things they care about. The initial goal is narrower: continuity
across related works, editions and languages, delivered on the same one-graph
architecture, so that the first launch already exercises what later expansion
reuses.

## Three values, one bet

1. **One graph.** One identity per referent across domains, languages and
   communities. Corrections, relationships and history accumulate instead of
   being rebuilt per site. A light novel, its manga, anime and game, their
   creators, the places they depict and the events where they appear are
   connected once and reused everywhere. A separate product per niche would
   face an entrenched specialist in every niche and lose the connections, which
   no specialist has.
2. **One experience.** Native objects instead of free text: a book list, not a
   post that names a few books; a tracked series, not a spreadsheet; a wiki whose
   infoboxes are graph facts. A person's identity, library, lists and reputation
   travel across every domain and Zone, and a person stays a recognizable brand
   rather than a username locked inside one community. Posts remain for opinion,
   humour and new ideas, and they can embed native objects.
3. **One engine.** A new domain is vocabulary, mappings, seed data and a Zone
   over shared capabilities, not a new application. The cost that must approach
   zero is backend complexity per domain.

The bet is to **build horizontally and launch vertically**. The architecture is
never partitioned by domain. Recruitment still proceeds one community at a time,
and each launch is chosen for proven demand, a weak incumbent and the
connections it adds to the graph.

The semantic web's lesson supports the bet from the other side: a knowledge
graph without its own user task hands its value to whoever owns the task.
[Freebase](https://blog.google/products-and-platforms/products/search/introducing-knowledge-graph-things-not/)
created consumer value inside Google's search, not as a destination. REZICS
therefore owns the tasks (tracking, wikis, lists, discussion, distribution) as
well as the graph.

## Wiki+: the flagship

Maintainer, 2026-09-30. Two entries lead into the same graph.

**The Work page is the hub.** It aggregates the Work's facts, ratings, reviews,
the reader's library status and progress, discussion and community, relations
to other works and editions, lists, and the wiki's summary (main characters,
timeline, chapter guides). [Bangumi's](https://bgm.tv/) subject pages, which
join wiki-maintained facts with ratings, collections, reviews and discussion,
are the reference.

**The wiki is its deep end.** Every Work can have a franchise-scale wiki as a
routed Zone that readers browse up to their own reading position. Building it
is one action: the holder of a text runs an independent, open-source local
toolkit with their own agent. The toolkit reads text, EPUB and common
visual-novel script formats, lets the agent extract characters, aliases,
relationships, events and places chapter by chapter with locators and short
quotations, matches them to existing entities through REZICS's API, and submits
them as a reviewable proposal. REZICS never receives the full text: the holder
chooses which model reads it, and a strict mode keeps inference on the holder's
machine. The toolkit circumvents no DRM and is permissively licensed so that any
agent or tool can embed it. REZICS supplies the protocol, evidence and
review; the holder supplies the compute. The
[wiki owner](../contracts/information-verification.md#a-big-franchise-wiki-for-every-work)
records the rules.

This is **wiki+**: not a feed of posts and not prose alone, but correctly
modelled facts with the reader's library, lists, ratings, tracking and
discussion on the same graph. It is the most visible proof of all three values,
and fan wikis are leaving ad-heavy hosts for exactly the speed and control it
offers ([GTA Wiki, March 2026](https://kotaku.com/gta-wiki-leaving-fandom-rules-censorship-ads-videos-ditching-2000679115)).

## Backend one, frontend free

Maintainer, 2026-09-30. Generated code makes frontend variety cheap. It does not
make backend complexity cheap, and an overly complex system is unacceptable even
with AI.

- **Backend.** One kernel, and each capability implemented once. A new
  descriptive domain adds no service, module, table, profile version, importer
  branch or domain condition. New behaviour enters only as a reusable capability
  that other domains can bind.
- **Frontend.** A Zone may have bespoke pages and components, and eventually
  very many of them. They consume the public APIs, hold no business logic and
  never require a domain-specific backend path. Whatever the UI does, an agent
  can do through the API.

## Who REZICS serves first

1. Multilingual enthusiasts and collectors, starting with light-novel and
   visual-novel readers who need edition selection, tracking and release
   continuity.
2. Curators, translators, wiki editors and creators who maintain supply and
   bring audiences.
3. Community operators and small publishers who need a complete site, imports,
   release administration and distribution.
4. Later, developers and answer engines that need dependable identity, evidence
   and updates.

Agents act for these people through the same authorized APIs. They are
contributors and clients, not a separate audience.

## Minimal compliance by narrowing scope

Maintainer, 2026-09-30. Zero budget stays. REZICS meets the duties that apply
from its first user and opens only what it can carry: child exploitation,
non-consensual intimate imagery and credible threats are day-one duties; other
harms are handled through reporting and removal; features whose obligations
cannot be met at zero cost stay closed. Ordinary features such as cover and
image uploads open at launch with free layered controls. The
[safety owner](../operations/trust-and-safety.md#safety-and-legal-readiness)
records the gates.

## What REZICS refuses to become

- A set of isolated niche clones, or one database per language or vertical.
- An advertising-driven page factory, or mass-generated pages chasing search and
  AI citations.
- A general map, restaurant or recruitment marketplace where answer engines and
  incumbents already win.
- A marketplace financed with creator payables, or a data broker promising more
  than contributors' rights allow.

## How success is judged

Proposed from R45 and R48 and adopted by the maintainer on 2026-09-30. Figures
count from the restart; they are hypotheses to test, not forecasts.

| Dimension | 12 months | 36 months |
| --- | --- | --- |
| Demand | 1,000 monthly active people completing core tasks; at least 35% of activated cohorts return in days 61–90 | 50,000 monthly active people; at least 40% cohort return, reported by language and source |
| One graph | At least 15% of activated people complete meaningful actions in two domains | At least 30% use several domains monthly; five maintained domains, one outside narrative media |
| One engine | A withheld domain passes the [expansion acceptance](platform-thesis.md#expansion-acceptance) | Three consecutive domain launches reach a useful pilot within five person-days each |
| Quality | At least 99% precision on 500 or more adjudicated identity decisions, abstentions reported | At least 95% of time-sensitive facts within their published freshness bounds |
| Business | Five contracted creators or two paying operator pilots | At least $25,000 monthly platform receipts; no payer above 25% |

### Kill criteria

Set before the experiments, so that evidence rather than momentum decides. Each
one names what changes when it fails; none by itself ends the company.

1. **Demand before breadth.** By 31 October 2026, study 20 target readers'
   actual tools, inventories and weekly repeated work, and obtain three
   commitments from people who will maintain knowledge or a wiki. Without a
   concrete recurring problem, change the initial task before enlarging the
   engine.
2. **Retention before expansion.** Within 90 days of a usable pilot, run two
   independently recruited cohorts of at least 30 people. At least 60% complete
   the first task unaided and at least 30% return for a meaningful action in
   week eight, or at the next relevant release for infrequent tasks. Logging in
   is not a meaningful action. Two failed revisions change the task or the
   channel; no new recruitment campaign opens before this passes.
3. **Reuse is real.** Record the backend changes each new domain needed. If
   additions keep needing them, narrow the configuration claim to the domains
   that pass.
4. **Total cost is lower.** Compare each expansion with a small standalone
   build using the same AI tools at equal quality, counting acquisition, review,
   rights, support and maintenance. The platform must need at least 50% less
   total effort, or platform investment stops growing.
5. **Knowledge is trustworthy.** Audit at least 1,000 stratified identity
   decisions. Automatic reconciliation needs at least 99.5% precision, with
   abstentions and coverage reported; below that, automatic matching pauses.
6. **Demand crosses domains.** If under 10% of 200 eligible people complete an
   adjacent-domain task without individual prompting, drop demand transfer from
   the growth thesis; engineering reuse may still stand.
7. **Capacity before opening.** A capability opens only with named primary and
   backup responders, its applicable legal duties met and a recovery drill
   passed.
