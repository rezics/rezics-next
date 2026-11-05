# Retained public-filter custody

`createPublicFilterCustody(pool)` is the sole Search-owned durable definition, observation, execution and reference
registry. `readPublicFilterConsumerCustody(pool, {queried, execution?}, context)` joins the canonical observation
and only the requested execution. Source binding must resolve and independently revalidate native Source
configuration, meaning and definition before using this trusted producer boundary. A stored fixture definition
is never Source identity, current permission, population coverage, an ACK or public query admission.

The adjacent contract contains the actual callable declarations. Registration reads the physical index's native
settings, stores that UUID and rejects immutable definition rebindings. Observation locators encode their home
as `home:uuid`; every primary/foreign key starts with that home. Reads join only that home. A target row selects
the current physical UUID; replacing the native name then registering invalidates earlier registrations without
mutating their definitions, observations or executions. Lifecycle producers must register physical replacements.

Migration `20261030090000_public_filter_custody.sql` creates `search.public_filter_target` keyed by
`(partition_no,physical_target)`, `public_filter_registration` by `(partition_no,id)`,
`public_filter_observation` by `(partition_no,observation)`, `public_filter_execution` by
`(partition_no,observation,id)` and `public_filter_reference` by `(partition_no,observation,token)`.
Registration IDs digest the consumer identity and native Source ID; the retained definition also has a
canonical digest. Tagged canonical encoding preserves undefined, arbitrary JSON objects and bigint losslessly.
Consumer, Source configuration, release identity, expanded input and compiler dependency keys cannot be overwritten.

Definitions admit releases through `RELEASE_LIMITS`: at most 1024 types, 4096 properties, 64 properties and 16
facets per type, and **4 MiB of JSON**. That is the release body alone, before capture, dependency keys or custody's
tagged encoding. The registration's **1 MiB** text ceiling therefore cannot serve as release admission. When the
complete tagged definition fits, the existing inline encoding remains readable and unchanged. Otherwise custody
retains the complete capture, configuration, meaning type, release digest and dependency keys, replacing only the
copied release body with `{authority:'semantic.readRelease',digest}`. The same semantic immutable release authority
retains every definition, including unused grammar, qualifiers, inherited types, saved filters and other meaning.
The existing published-release point lookup, or registered-composite lookup for composed meaning, establishes that
this exact immutable identity is durable before registration. Composites retain their original immutable parent
and extension closure in that authority; custody creates no release catalogue or Source mirror.

**Selected owner proposal for the custody read contract:** `CustodyFound.definition` is
`CustodyRetainedDefinition`; its `meaning.release` is either the original inline `Release` or
`CustodyReleaseReference`. Registration still takes the original complete `CustodyDefinition`, validates its digest
and admits the full expanded filter against that release before native I/O. A reference is complete retained meaning
by immutable identity, never an abbreviated release to pass to `admitFilter` or Source as a `Release`. Consumers needing
the body use the existing semantic `readRelease` authority in their own bounded meaning-loading work. The shared
`PublicFilterProjectionMeaning` contract is unchanged; this custody return-shape proposal does not claim a new Source
export or grant. No current production read/write caller outside this module consumes the custody definition, and
custody is outside the generated HTTP client declaration closure.

A cold custody join returns the same bounded immutable reference and independently point-probes its authoritative
identity, without loading or expanding four MiB during a page. This includes lookup SQL, parameters and returned
metadata in custody cost. It returns `found`, never permanent preparation. The complete release is recoverable through
the existing immutable owner, not through a process cache. Native scenarios publish a near-four-MiB catalogue through
the ordinary authorized command, preserve the bundled grammar and use native additional released facets and
qualifiers. They charge registration, keyed joining and cold custody recovery, and separately inspect the original
authoritative body to prove complete meaning. Reading that full body is not hidden inside the page or claimed free.
Neither the one-MiB retained row ceiling nor the four-MiB whole-operation/page ceiling increases. No schema migration
is needed: old inline rows and the new tagged reference rows share the original bounded storage column.

`openPit` opens an actual engine PIT and verifies the native physical identity before and after opening.
`retainPrepared` commits an immutable prepared row set, build and bigint generation owned by a new observation;
it does not assert population completeness. Each observation stores its own covered cut. Executions append only
under a durable active use lease and retain the original start plus original/terminal rows. Exact retries are
idempotent; different values under the same execution ID reject. Observation-only reads return execution:null.

Acquire precedes external engine work; release belongs in the producer's finally block. Leases expire at the
request deadline (at most five minutes) so process loss cannot permanently pin a PIT. Callers must enforce that
same deadline on external work. Close installs a durable admission barrier, drains existing leases and releases
only that observation's engine reference. After a committed release, one indexed active-maximum probe may signal
waiting factories in this process when the last active reference is gone. Signals only advance scheduling; close
always reads durable active references again, including when delivery of an actual old maximum was held across
the real last release. A signal never permits native deletion. Close performs at most three indexed maximum probes
and two timer waits per invocation. Timers fall back halfway through the remaining caller time and near the deadline
(with at most 100ms reserved for native close), or at the observed lease expiry if earlier. This also permits bounded
revalidation without a local signal, including another process's release. Exhausted work with a still-live lease
returns unavailable/deadline and leaves the barrier and PIT owned for retry. There is no background SQL polling,
listener connection or checkout retained during waits. All probes and rejected/expired work are charged. For one
owned PIT, even all three probes use at most nine SQL submissions; release uses two. Existing native PIT cleanup
batching, deadline enforcement and recovery remain in place. Renewal probes the existing PIT and CASes its revision and tuple;
confirmed native PIT loss closes admission only for that exact tuple and revision.
Retirement and physical replacement never inherit retained coverage. No transaction spans engine I/O.
Factory disposal drains local calls; committed state survives recovery and supplied resources remain open.

The keyed joined read uses one SQL statement. Returned costs include SQL submissions, returned/affected rows,
encoded SQL/parameter/result bytes and engine requests, including failures and repeated drain work. Native plan
capture measures examined rows and blocks separately; counters do not claim returned rows equal examined rows.
This metadata must fit inside the consumer's existing whole-read budget; custody introduces no extra allowance.
Unknown custody remains pending for erasure/inventory. Complete coverage, all-role erasure, late-writer control,
Source permission, full consumer/default wiring and public disclosure remain their respective owners' work.

Native PIT locators are additionally retained in `public_filter_pit` keyed by `(partition_no,observation,id)`
(the ID digests the full engine locator). Both CAS winners and losers remain owned until the observation drains;
close releases exactly these locators in bounded batches. `public_filter_prepared`, keyed by
`(partition_no,registration,build,generation)`, rejects different row sets for the same immutable generation.
