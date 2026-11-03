# Native mixed discovery query

This page describes Search's execution of the adopted second-scope mixed query. The
[universal search conditions](../../../../docs/search-conditions.md) document owns condition meaning, domain
applicability, authorization and privacy rules. The [Search Goal](../../../../docs/goals/search.md) owns the Goal
boundary. A source-level implementation does not prove native producer readiness or runtime acceptance.

## Kinds and applicability

The closed registry supplies the kinds admitted to one `discovery-v1` request. The native query searches the full
registered population through one common generation, one ordered engine sequence and one opaque continuation.
New metadata kinds do not create endpoints or client-side federated searches.

| Kind | Primary identity | Conditions |
| --- | --- | --- |
| Released Subject type | Subject UUID plus registered type | Text, kind, released type/subtype and applicable semantic conditions |
| Public Collection | Existing Collection UUID | Text and kind |
| Public review | Existing thread UUID plus review discriminator | Text and kind; ordinary discussions are outside this slice |
| Space | Space UUID, with its carried Realm as context | Text and kind; the Realm does not create another hit |
| Account | Account UUID | Text and kind |

Collection, review and Space text uses only each producer's approved public metadata or disclosed review opening
text. Private membership, curator predicates, private producer fields and inaccessible parent text cannot affect
matching, exclusion, ranking or displayed summaries.

`kind` applies to every registered kind. `type` and semantic statement predicates apply to Subject kinds only.
For a kind outside a leaf's declared domain, both truth polarities remain unproved: a Subject-only leaf and its
`NOT` cannot admit a Collection, review, Space or Account complement. An independently true applicable `OR` branch
may still select its kind. Every referenced resource is authorized before execution, even under `NOT` or a true
`OR` branch. Universal condition evaluation and disclosure rules remain authoritative.

## Request, ordering and currentness

The caller uses the existing `POST /v1/subjects:search` endpoint with `representation: "discovery-v1"`. Text,
filter, sort, limit, language and presentation options are admitted and bound as one request. Kind selection stays
inside that tree. The hit cursor is bound to the principal, admitted request, registry and native observation; the
metadata cursor pages the fixed configured-kind directory independently and never removes unshown kinds from hit
search.

The engine assigns one sequence to every kind. `id` order breaks ties by UUID, kind and canonical identity;
`name` and relevance use their primary key followed by those same deterministic ties. Each page rechecks whole-query
eligibility and current disclosure before publication. A withdrawn result cannot be carried onto a continuation.
Same-UUID hits remain distinct when their registered kinds or canonical identities differ.

Kind counts are never inferred from a producer census, engine bucket, index row count or page length. The initial
page may show only a certified positive lower bound from current returned witnesses; otherwise the count is
unavailable. Continuations and incomplete kind-filter populations keep counts unavailable.

## Producer and retained-reader seams

Content owns the native Collection, review and Space producer projections and their complete generation
population. Its shared-union outcome supplies the closed kind identities and public summary variants; its
projection outcome supplies population production. Search consumes those seams for native query decoding,
current owner eligibility, whole-query exclusion/order checks and response execution. Search does not reconstruct a
second source from point reads or semantic Subject shells.

Owner currentness and hydration must finish before the retained Search/Home reader publishes. Preserve the existing
`search`, positional `currentPrimaryCandidates`, `finish` and `close` custody: one retained native observation owns
the first page, continuation, primary checks and terminal publication. If a kind or its owner evidence is absent,
return typed readiness/unavailable and leave its count unavailable; never present that missing population as empty.
Content's mixed Home consumes this native union, and Web renders the delivered hits.

The current base has no expanded metadata registration, candidate decoder or owner currentness/hydration adapter.
The Search-side guard therefore fails closed on an unexpected metadata candidate. Enabling successful Collection,
review and Space results requires the owner seams above and the named native acceptance; this page does not claim
that source integration alone proves runtime behavior.
