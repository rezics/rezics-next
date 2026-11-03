# Native mixed discovery query

This page records the adopted second-scope mixed-query contract and what the retained source currently executes. The
[universal search conditions](../../../../docs/search-conditions.md) document owns condition meaning, domain
applicability, authorization and privacy rules. The [Search Goal](../../../../docs/goals/search.md) owns the Goal
boundary. A source-level implementation does not prove native producer readiness or runtime acceptance.

Decision: Search owns the shared hit and summary union, ready kind directory and strict document codec; producer owners
supply their native populations and current disclosure. A kind is queryable only when its native current reader is
ready and cannot contribute a count otherwise.

Decision: Render current viewer entry state and rating inline on each admitted Subject card; when the one viewer-facts
envelope is unavailable, suppress its private rows and show one localized page notice while keeping current public hits.

Decision: Open a Subject card's native destination for Library and rating actions; their existing subject-page command
ports remain the only write path and reauthorize each action.

Decision: Mixed Search uses English when the caller omits languages; the web caller continues to send its selected
locale preferences, keeping every current label and alias projection bounded to the requested languages.

## Kinds and applicability

The closed registry supplies the kinds admitted to one `discovery-v1` request. The native query searches the full
registered population through one common generation, one ordered engine sequence and one opaque continuation.
New metadata kinds do not create endpoints or client-side federated searches.

| Kind                  | Primary identity                               | Conditions                                                           | Retained-source readiness |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| Released Subject type | Subject UUID plus registered type              | Text, kind, released type/subtype and applicable semantic conditions | Registered                |
| Public Collection     | Existing Collection UUID                       | Text and kind                                                        | Default owner adapter     |
| Public review         | Existing thread UUID plus review discriminator | Text and kind; ordinary discussions are outside this slice           | Default owner adapter     |
| Space                 | Space UUID, with its carried Realm as context  | Text and kind; the Realm does not create another hit                 | Default owner adapter     |
| Account               | Account UUID                                   | Text and kind                                                        | Registered                |

The default registry adds Collection, review and Space only when each native current-reader adapter is ready. Its
kind directory, population filter and cursor digest use that same ready set. The strict document codec keeps native
Commerce/Content identities separate from the closed public Library/Content/Community result keys. Collection cards
are projected only after current source and disclosure checks; review opening text and Space destination/context are
read from current owner summaries. Private membership, curator predicates, private producer fields and inaccessible
parent text cannot affect matching, exclusion, ranking or displayed summaries.

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

`createNativeDiscoveryRegistry` supplies released catalogue types, Accounts and ready owner adapters. The shared
reader captures one observation, consumes the ordered mixed engine frontier, checks whole-query current eligibility,
hydrates summaries and finishes disclosure before it publishes a page. Its cursor binds the principal, admitted
request, ready kind directory and observation; counts use only bounded positive current witnesses and never a census.

Commerce exposes `CollectionDiscoverySource` and current public Collection summaries. Community exposes the native
Space source and current Space summaries, including its current destination and carried Realm. Content exposes
`ContentReviewDiscoverySource`; the default adapter is ready only when the configured native review source covers the
complete eligible population and current summaries. A Space without a current public address is excluded from the
public result union. Missing or malformed current owner evidence rejects the page instead of producing an empty
result.

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

## Complete-page work and retained state

For an admitted hit limit `L` from 1 through 100, the retained Search reader examines at most
`R = min(600, 6L + 3)` raw candidates across at most three windows of at most 200. The `examined` total includes
rejected rows, duplicate identities, replayed candidates and empty lookahead; refill does not restart that allowance.
The existing current-candidate and owner-hydration bounds apply within those same raw windows. The response retains at
most `H = L` complete mixed hits, eight kind rows and one existing hit cursor plus the independent kind cursor.

Enrichment receives `S <= H` Subject identities. Search passes the ordered **raw** list, including duplicates, to
`readListPresentationFacts` once for display and once immediately before Search's final guard. Each call admits at
most 100 raw originals, and its own complete mapping, original/terminal, selected fact, provenance, consent, account,
source-fence, related-item and active-release rechecks are bounded by the Semantic producer contract. The second
original-keyed result must match both terminal identity and display facts or the retained Search cut restarts. Public
figures cover at most `F <= S` creative works, use the Global standard question on one page snapshot, and are read
again before the final guard; each producer call admits at most 256 IDs. No per-result reads are added.

For an authenticated principal, the one Library envelope has at most `V <= S` ordered rows, at most 100 inputs and
16,384 UTF-8 input bytes. `readViewerFacts` uses the caller-owned account-home repeatable-read client; the client is
released before `viewerFactsCurrent`, which rechecks the actor, identity mappings and question. The producer enforces
65,536 UTF-8 output bytes. An input or output response-limit outcome withholds all private rows while retaining the
public Search page. The web page retains only the current `H` hits and their at most `V` viewer rows; cursors remain
transient under the existing request owner.

Search does not issue Library or rating mutations from result rows. The Subject destination opens the existing
command-port surface, where each write reauthorizes. Native all-pool accounting and connected browser inspection
remain controller acceptance; no per-seek cap, second cursor or runtime funding protocol is introduced here.
