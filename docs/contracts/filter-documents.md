# Declarative filters and query state

## Intended contract

FilterDocument is a proposed shared descriptor for ordinary and advanced
editors. It has no deployed schema or round-trip client test yet, so this page
remains until both editors preserve unsupported-to-that-UI fields. An empty
document supplies no hidden query, sort or page defaults. It contains sparse
categories, typed predicates and controls. Server field and Work policies set
privileges and budgets; a preset cannot enlarge either.

The future compiler must intersect site, resource and user scopes, including
a mandatory fixed-Realm site boundary. Named terms resolve through an explicit,
speaker, entry or Global policy before compiling their admitted definitions;
equal-priority meanings remain ambiguous. Saved filters retain exact
DefinitionRefs and Context revisions. A new concept cannot erase another's
contextual uses, and labels or navigation Path/Sense cannot choose meaning.
Semantic selection, preference, disclosure, populations and acceptance scopes
remain separate. The compiler binds Context roles, Main Version, rating policy
and semantic match intent. It canonicalizes identical predicates without
losing meaningful multiplicity. Related predicates that describe one
participant or occurrence must bind to that same occurrence. Count grain,
display groups and optional self-filter-excluding facets follow
[statement aggregation](search.md#statement-aggregation).

Admission must check descriptor shape, node count, field/operator applicability,
depth, sources and the parent budget of any nested Block before Jena execution.
Candidate scans, graph expansion,
time, memory and bytes need bounds. Saved query state excludes cursors;
continuations bind policy, semantic, preference and disclosure revisions and
report actual selection, data/index generations and completeness.
Text hit limits cannot substitute for final post-filter limits or a snapshot
across ordinary SPARQL offset requests. Temporal controls preserve possible
and definite time plus calendar semantics. Rating controls preserve question,
population, scale, time basis and aggregation. A display edit cannot create a
rating Context or recast a correction as a new vote. Restore rechecks format
and capability eligibility. Private text
and unsupported query shapes fail explicitly. Each client adapter must verify
scope intersection, empty and advanced documents, stale cursors and graph/text
semantics.

The current narrower [graph query schema](../../services/main/src/modules/graph-query/schema.ts)
and [grouped Statement read](../../services/main/src/modules/work/search-grouped.ts)
implement pieces of this contract, not FilterDocument itself.
