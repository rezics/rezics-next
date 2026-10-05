/** A continuation's expiry is fixed by its first page, never renewed by use.
 * Discovery retains immutable rows; registered Access families retain membership
 * through owner revision fences. Live graph/Access checks still decide disclosure. */
export const READ_BASIS_RETENTION_MS = 5 * 60_000;

/**
 * G-336 decision (2026-09-28): defer enabling a universal retained-read envelope.
 * Prefer native TDB2 read transactions for the graph part of a future envelope;
 * do not copy the corpus or silently relax decodeReadCursor's sequence check.
 * ReadSnapshotProbe/Test in infra/jena/command-module/src/test/java/com/rezics/jena
 * contain the executable comparison and counterexamples. At that decision this
 * constant retained discovery ROWS only, not TDB, Lucene or Access state.
 *
 * Registered owner exception (2026-10-05), in membership.ts: Home and Realm
 * thread lists retain Access population revisions, with follow, target-index,
 * personal and private history-admission revisions where used. Their encrypted
 * cursors have this fixed deadline and retain the graph epoch as a recovery
 * fence, but unrelated graph sequences do not change membership. A changed
 * owner revision gives 409 restart; disclosure is checked live on every page,
 * and hidden candidates leave holes rather than being replaced. Votes retain
 * keyset semantics, not historical scores. There is no graph pin, copy or cache.
 * Realm ranked continuations may use their already-admitted population while
 * later source events await projection; first pages still require a complete cut.
 * Content epoch, recovery, history-index readiness and rolling expiry remain fenced.
 * The per-page graph consistency fence still applies, so sustained writes
 * DURING hydration may exhaust a page's budget. This is an owner-specific
 * membership guarantee, not the universal graph/text/Access snapshot below.
 *
 * Evidence and applicability:
 * - Jena 6.2.0 begin(READ)/end() can retain one graph version across writes, but
 *   the transaction belongs to its opening Java thread. Passing DatasetGraph to
 *   a later HTTP worker opens a different view. ReadSnapshotTest proves this on
 *   native TDB2, including a delete that the old reader continues to see.
 * - Our FilteredGraphTextIndex opens DirectoryReader on every query. Its result
 *   advances while the TDB transaction remains old (also tested). Retaining TDB
 *   cannot establish a paired text/graph snapshot for search.
 * - read-snapshot-access.test.ts demonstrates PostgreSQL repeatable-read inputs
 *   remaining allowed after revocation. The final check must use a NEW Access
 *   snapshot. Current Access helpers each start their own transaction, and many
 *   use FOR SHARE, so wrapping workRead in a read-only transaction is insufficient.
 * - read-stability.test.ts records the present HTTP gap: unregistered continuations
 *   expire after unrelated commits; discovery keeps membership but can exhaust
 *   its current-disclosure hydration retries under writes at every position read.
 * - A custom before-image overlay would duplicate native TDB versioning and need
 *   complete writer coverage, indexed historical joins and recovery proofs. A
 *   bounded result materialization remains suitable for discovery/search, but
 *   cannot represent an arbitrary unbounded relation. Prefer native graph pins
 *   plus owner-specific retained SQL/result membership over either replacement.
 *
 * Measured on a private copy of fx-medium-c9f6e4fdcb52 (100k Works, 10k public
 * MatchUnits, about 3.03m quads), Jena 6.2.0/JDK 21.0.12, 2 CPUs, 2 GiB heap:
 *   distinct pins | write p95 ms | sampled RSS MiB | held heap MiB | file growth MiB
 *               0 |          452 |           300.3 |          48.9 |            24.0
 *               1 |          750 |           302.6 |          48.8 |            24.0
 *               8 |          528 |           304.5 |          48.9 |            24.0
 *              32 |          517 |           314.2 |          49.1 |            24.0
 *             300 |          468 |           420.5 |          51.2 |            64.0
 * Each trial timed 300 raw head replacements after creating its distinct pins;
 * all retained values survived. These omit command validation/receipts/text.
 * The 300 pins took 205 ms total to open/probe (excluding intervening writes),
 * and heap after releasing them and requesting GC was 48.9 MiB. Sequential
 * shared-host trials do not establish causal latency differences or a lease cap.
 * In-memory copying stopped at 109k quads in 2.00 s after its sampled heap growth
 * exceeded 256 MiB. Named-graph copying held the writer for 10.01 s, copied only
 * 645k quads and grew files by 360 MiB before abort. Neither completed even the
 * current graph. Reject these eager copies for the interactive read envelope;
 * this is not a claim that every optimized copy design is impossible. Full raw
 * metrics/method/limits: infra/jena/command-module/src/test/resources/read-snapshot/2026-09-28.json.
 *
 * Proposed owner protocol (not an implemented API):
 * 1. An authenticated internal command-module endpoint admits a dataset-scoped
 *    opaque lease and captures {instanceId, dataEpoch, routingEpoch, sequence}
 *    INSIDE its native read transaction. One dedicated virtual thread owns
 *    begin/query/end, with a bounded serial queue. Queries admit SELECT/ASK only;
 *    reject UPDATE, SERVICE, external FROM and unbounded request/response bodies.
 *    SELECT LIMIT alone does not bound native work: enforce cancellation and the
 *    existing ten-second page deadline/call/byte limits inside the JVM as well.
 *    Charge lease admission/use to those same call budgets; introduce a bounded
 *    Access proof-batch budget rather than hiding per-row SQL behind one callback.
 * 2. Authenticate/decrypt/bind continuations before choosing a lease. Bind family,
 *    filters, ordering, principal, acting subject and owner-position vector.
 *    Store the lease ID in the encrypted cursor, never expose it as authority.
 *    Expiry is fixed at first-page admission, never renewed. Replays share the
 *    same retained relation/order; new heads cannot alter its continuation key.
 *    Unknown, expired, restarted or recovered leases give an explicit 409 restart,
 *    never a fallback to current rows. New admissions over capacity give 503.
 * 3. Reserve capacity until expiry; do not evict a live promised basis. Bound
 *    leases, distinct versions, queue depth, bytes, per-principal admission and
 *    native execution before accepting a lease. Cancel/close on deadline, expiry,
 *    error and server shutdown; block use across restore/routing/instance changes.
 *    A disconnected first-page client must not leave a lease beyond its fixed TTL.
 *    Choose these caps from a five-minute mixed-load capacity run, not this probe.
 * 4. Use one short repeatable-read Access transaction for each page's authority
 *    inputs, via owner read-only helpers accepting the SAME PoolClient. Do not
 *    hold a PostgreSQL connection/snapshot for five minutes or pin old grants
 *    across pages. Record every authority dependency (principal, representation,
 *    subject, grant, membership, exclusions, policies, recovery and expiry).
 *    After hydration, validate the whole proof vector in one fresh, bounded
 *    Access transaction at the delivery decision point. Check wall-clock expiry
 *    as well as revisions. An old grant must never authorize a later page.
 * 5. Separate retained membership/value reads from current disclosure explicitly.
 *    Each family supplies bounded page dependencies, including exact revisions;
 *    current erasure, protection, publication, title restrictions, Realm policy,
 *    media visibility and Source-name disclosure must be checked OUTSIDE the
 *    retained graph. Revalidate the affected proof set, not the global graph
 *    sequence, so unrelated churn cannot starve delivery. Hidden members produce
 *    holes and page counts; never refill by silently changing the pinned basis.
 *    This is why a blanket AsyncLocalStorage redirect of Fuseki.query is unsafe.
 * 6. Search must pin a paired Lucene DirectoryReader with its graph position and
 *    write/recovery fences, or retain its bounded immutable result rows. Capture
 *    the pair at a short writer barrier; never hold that barrier for the lease.
 *    Repeated position probes alone would retain the existing starvation problem.
 *    SQL families need retained membership too: library/status uses Content, whereas
 *    follows, feeds, directories and management indexes have Access revisions.
 *    Their cursor.order fences cannot just be ignored. Register each family with
 *    its membership owner, position vector and current-disclosure verifier;
 *    graph-only implementation cannot claim every-family continuation stability.
 *
 * Release gates: all family continuations under sustained relevant/unrelated
 * writes; same-token replay/parallel pages; revocation/expiry/erasure/protection
 * during hydration and final validation; paired Lucene changes; epoch recovery;
 * lease saturation, disconnect/cancel/TTL/shutdown cleanup; five-minute write/RSS
 * and old-version reclamation evidence on the retained 100k/10k fixture. No claim
 * about 500 million entities follows from that corpus. Until those owners and
 * gates are integrated, retain the bounded retry/explicit restart behavior.
 *
 * Primary mechanism references (read 2026-09-28):
 * https://jena.apache.org/documentation/txn/transactions_api.html#multi-threaded-use
 * https://jena.apache.org/documentation/rdfconnection/#remote-transactions
 * https://jena.apache.org/documentation/tdb2/tdb2_admin.html
 * https://www.postgresql.org/docs/18/transaction-iso.html#XACT-REPEATABLE-READ
 */
