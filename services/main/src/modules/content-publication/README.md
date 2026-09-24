# Content publication boundary

`publishPinnedContent` requires a trusted `content.publish` admission, a current
PostgreSQL Content draft head and the exact Content revision/digest/owner epoch.
Before pinning, it requires the reviewed `content-publication-v1` variant and
decision shapes in both generated model artifacts and Fuseki command health.
This fail-closed gate prevents an unvalidated graph write.

The guarded graph command records the exact Content revision, digest, preparation
ID and Content owner position with the variant publication head, graph receipt and
outbox in one Jena transaction. No SQL or body fetch runs inside that transaction.
`reconcilePinnedContentPublication` reads the exact graph receipt, verifies its
admission, source reference and both owner epochs, then settles the Content pin.
A missing or ambiguous graph receipt leaves the pin pending. A graph cancellation
with a guarded stale-head receipt can release it; a timer cannot.

`selectPublicContentSearch` is an internal release primitive. Its caller must
pass the fresh claimed, dispatch-eligible Access registration for the exact
reviewer, variant, request digest and `content.search-eligibility` scope. The
reviewer explicitly attests public disclosure and an original-contribution
rights basis. The primitive independently resolves the active publication's
exact Content revision, verifies available bytes and digest, recomputes the
authored draft intent from immutable provenance and checks the sealed author
admission, Content save receipt and matching owner position. Unverified or absent
proof denies release. This primitive
does not expose an HTTP route. It requires the expected
prior eligibility head. A native validated graph command writes the current
eligibility head, immutable decision, receipt, one typed outbox event and next
graph sequence together. Exact graph receipts resolve same-key replay and lost
responses; stale heads receive a terminal cancellation receipt.

The bounded Content projection relay consumes one contiguous Content outbox
position at a time. It acknowledges draft/preparation events, verifies terminal
publication positions against the settled Content pin and exact graph receipt.
An active pin alone has no public search authority: projection also requires a
separate current public eligibility decision for that exact publication. It then
writes a guarded public MatchUnit from an exact revision body, validating both
the projection anchor and MatchUnit native shapes. The graph command carries its
own deterministic receipt, source position and typed outbox event. Search over
Content variants checks the Content checkpoint, graph publication inventory and
jena-text generation before returning a complete result. It is a distinct lane
from Main Version and Realm-effective Contribution search.

Main's process initializes a durable Content cursor and runs this relay one
event at a time. Poll failures retry from the last acknowledged position, and
search readiness requires the cursor to equal the current Content owner
position. The public `public-content-phrase-v1` query profile returns exact
Content variant matches through `POST /v1/queries`. The relay stops before
active publication if either reviewed native profile is absent. A successful
live eligibility decision and MatchUnit projection have an isolated native
integration check. Broader Content erasure/GC and restore qualification remain.

`yarn search:rebuild` is a controlled development-stack or isolated persistent-QA
maintenance operation. The latter uses `--profile qa --run-id <id> --persistent`
after starting that project with the same options; ordinary QA tmpfs is rejected.
Stop Main and other writers first. A maintenance-token-only native command
removes the public search anchor, so all public text lanes remain unavailable
through process restart or an interrupted rebuild. The command records a durable
receipt and source cut. Cleanup deletes only Content MatchUnits; the native
transaction compares the actual public graph before and after, rejecting any
non-Content deletion. A terminal cleanup receipt prevents a restart from
deleting freshly replayed units. An independent Content cursor then replays the
retained outbox with job-specific MatchUnit and receipt identities. Missing or
erased exact bytes stop replay and leave search quarantined.

The operator command stops Fuseki, runs the pinned `jena.textindexer` on that
project's named volume, and restarts it. Activation compares current eligible
publication heads and their committed publication/eligibility receipt chains,
exact PostgreSQL bytes and digests, RDF MatchUnits, all
Lucene body entries and the CJK probe; it also checks both owner cuts. A short
PostgreSQL owner lock and graph sequence guard close the final cross-owner race.
Only then does the native maintenance command restore the public anchor and
advance the text index generation. The ordinary Content checkpoint is promoted
from the independent rebuild cursor; a crash between graph activation and
checkpoint promotion is replayable from the activation receipt. The recorded
offline digest identifies the operator invocation and log, while the complete
reader/source comparison is the activation guard. An isolated native QA drill
now seeds admitted exact Content, publishes and approves a replacement revision,
interrupts after quarantine at the changed Content cut, rejects activation
without the cleanup receipt, then resumes the same job through the offline
indexer. It proves a new generation, the replacement's exact revision and body,
and absence of the old MatchUnit and body from public search. The operation
targets single-host named volumes and a bounded 50,000-unit inventory. Physical
erasure has no admitted product command yet; the separate fault test removes
source bytes directly to prove a fail-closed replay, not a complete erasure or
withdrawal lifecycle. Production restore and that lifecycle remain open.
