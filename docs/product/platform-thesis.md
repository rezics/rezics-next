# Product thesis and vertical engine

## The vertical engine is the product

Decision 34, maintainer, 2026-09-29; the manifest and acceptance design were
settled by the product manager under that delegation on the same date.
Cost is why REZICS exists. A new descriptive catalogue should reuse the platform
through configuration: a multilingual visual-novel database, science-fiction
index or LLM/benchmark index should not require a separate application.

A small behavioural kernel stays in code: Work identity and revisions; series,
parts and episodes; editions/releases and coverage; people, organizations and
fictional entities; qualified relations and credits; rating/review targets;
progress units and sessions; dated events; authority, disclosure, custody,
bounded queries and recovery. Fictional characters gain no Agent authority.
New behaviour still requires engineering. New descriptive fields should not.

A versioned vertical manifest combines a namespace and steward, descriptive
types over admitted structural bases, property definitions, page sections,
saved views, rating/review contexts, source mappings and rights, a Zone template,
and labels/help in arbitrary content languages. It reuses existing owners for
meaning and operations. Activation reviews an exact revision and its dependencies;
configuration cannot execute arbitrary code, queries or remote schemas.
[Open vocabulary](../contracts/classification.md#restricted-structure-and-open-vocabulary)
and [complete traversal](../contracts/queries.md#complete-traversal) keep those
definitions extensible and their inventories exhaustive.
[JSON Forms](https://jsonforms.io/docs/uischema/) separates data from presentation
schemas; [Wikibase](https://www.mediawiki.org/wiki/Wikibase/DataModel) preserves
qualifiers and references. These are precedents for the design, not proof of
REZICS's cost or usability.

Every type gets a useful default page: cover/avatar, localized names, facts
from its property schema, relations, ratings, reviews, discussion, wiki, lists
and sources. Books, Games (including software) and Media (anime, manga, film
and TV) override a few slots of that page. Views, rating contexts, import
mappings, Zone templates and page sections are shared assets. An unfamiliar
domain must not inherit book-only controls or require another route tree.

## One graph, many language fronts

Decision 35, product manager under maintainer delegation, 2026-09-29.
Each vertical has one multilingual graph and per-language community Realms.
A correction in one language improves the shared catalogue; communities retain
their own interpretation and editorial decisions. This avoids repeated imports,
identity splits and divergent corrections. The
[language contract](../contracts/content-languages.md) and
[Context contract](../contracts/context.md) own those distinctions.

Open dumps reduce acquisition cost; their licences still apply to reuse and
export. The selected seeds are Arena's
[CC BY 4.0 leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset),
VNDB's [ODbL/DbCL dump](https://g.blicky.net/vndb.git/tree/util/dump/LICENSE-ODBL.txt?h=2.10&id=5a3a446b0530632942c577edbf10e9c7c2fb6fa9)
and ISFDB's [CC BY 4.0 data](https://www.isfdb.org/cgi-bin/languages.cgi).
Retain attribution and modifications; apply
[ODbL's derivative-database obligations](https://opendatacommons.org/licenses/odbl/1-0/).
Provenance partitions alone do not resolve derivative versus collective scope.
Check each selected archive's notices and exceptions: cover art, quoted text,
descriptions and model weights do not inherit the dataset licence automatically.
ISFDB and VNDB pages could not be re-fetched during this migration; verify the
archive notices before publication, as the [source owner](../contracts/source-lifecycle.md)
requires.

## First manifests and proof

Settled research adoption, product manager under maintainer delegation,
2026-09-29. These are engine demonstrations, not permission for broad acquisition
campaigns or a claim that their source importers already work:

- **LLMs and benchmarks:** exact model releases, evaluation conditions,
  benchmark/dataset/harness revisions, task/language, units, uncertainty, sample
  size and observation date. User reviews remain separate from benchmark
  results. [HELM](https://arxiv.org/abs/2211.09110) motivates comparisons qualified
  by scenarios and metrics rather than a universal model score.
- **Visual novels:** usable releases qualified by language, platform, region,
  complete/partial/trial coverage and translator provenance. Correlate all
  conditions on one release; translated names do not prove playable translations.
- **Science-fiction books:** existing Book and series structures with ISFDB
  titles, variants, publications, contents, contributors and awards. A publication
  can contain several Works; source variants need explicit correspondence.

Freeze the engine, then have an administrator and an API-only agent each open
an unanticipated fourth vertical within **four working hours**, given an admitted
format and documented source basis. No source edits or deployment are allowed.
Exercise full traversal beyond former bounds, review submission, interrupted
import recovery, export/re-import, non-UI RTL content and preservation of Advanced
state. This sharpens the maintainer's original “LLM index in days” test and remains
an unvalidated acceptance target. Configuration does not make stewardship,
source rights or a new parser free.
