# Native mixed discovery query

This page records the adopted second-scope mixed-query contract and what the retained source currently executes. The
[universal search conditions](../../../../docs/search-conditions.md) document owns condition meaning, domain
applicability, authorization and privacy rules. The [Search Goal](../../../../docs/goals/search.md) owns the Goal
boundary. A source-level implementation does not prove native producer readiness or runtime acceptance.

Decision: Search owns the shared hit and summary union, kind registry and strict document codec; producer owners
supply their native populations and current disclosure. Until those Search-owned assemblies admit a kind, it remains
unavailable and cannot contribute a count.

## Kinds and applicability

The closed registry supplies the kinds admitted to one `discovery-v1` request. The native query searches the full
registered population through one common generation, one ordered engine sequence and one opaque continuation.
New metadata kinds do not create endpoints or client-side federated searches.

| Kind                  | Primary identity                               | Conditions                                                           | Retained-source readiness |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| Released Subject type | Subject UUID plus registered type              | Text, kind, released type/subtype and applicable semantic conditions | Registered                |
| Public Collection     | Existing Collection UUID                       | Text and kind                                                        | Not registered            |
| Public review         | Existing thread UUID plus review discriminator | Text and kind; ordinary discussions are outside this slice           | Not registered            |
| Space                 | Space UUID, with its carried Realm as context  | Text and kind; the Realm does not create another hit                 | Not registered            |
| Account               | Account UUID                                   | Text and kind                                                        | Registered                |

The installed registry currently contains released Subject types and Account. Its native hydrator and strict document
codec also cover only those owners, so Collection, review and Space results cannot yet be returned by this source.
Their text must use only approved public metadata or disclosed review opening text. Private membership, curator
predicates, private producer fields and inaccessible parent text cannot affect matching, exclusion, ranking or
displayed summaries.

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

## Producer readiness and retained-reader execution

The current registry is built from released catalogue types and Accounts. `createNativeDiscoveryRegistry` supplies
their source adapters and complete current summary hydrators. The shared reader captures one observation, consumes
the ordered engine frontier, checks whole-query current eligibility, hydrates summaries and finishes disclosure
before it publishes a page. Its cursor binds the principal, admitted request, registry and observation; counts use
only bounded positive current witnesses and never a census.

Commerce exposes `CollectionDiscoverySource` and current public Collection summaries. Community exposes the native
Space source and current Space summaries. Content exposes `ContentReviewDiscoverySource`, but the review adapter has
no default producer and reports `unavailable` until the complete eligible population and current summaries are
covered. These owner seams do not make the new kinds executable by Search on this base: registration, shared
projection encoding, candidate decoding, owner currentness and complete current hydration are not wired into the
retained discovery query.

New-kind integration must keep the existing Search/Home invocation and its `search`, positional
`currentPrimaryCandidates`, `finish` and `close` custody. Collection raw pages advance by the last examined full key;
a short raw page exhausts even when no row is eligible. Collection census and unverifiable dynamic Publication
witnesses remain unavailable. Missing current owner evidence or withheld complete hydration stays typed
unavailable; it never becomes a false empty page or count.

Current Subject and Account summaries are assembled in deduplicated batches of at most 100 identities. A current
source row whose complete summary is withheld, malformed, foreign or inconsistent refuses the whole page; an absent
source row still excludes that candidate. Summary objects are copied before later owner reads. The installed reader
admits the closed transport shape, full identity ties and metadata even for an empty final page before signing its
cursors, and the endpoint applies the same admission at serialization. Hit pages and metadata-only pages retain
separate shapes.
