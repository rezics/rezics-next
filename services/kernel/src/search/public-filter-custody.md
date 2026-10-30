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
Registration IDs digest the consumer identity and native Source ID; the complete copied definition also has a
canonical digest. Tagged canonical encoding preserves undefined, arbitrary JSON objects and bigint losslessly.
Consumer, Source configuration, release, expanded input and compiler dependency keys cannot be overwritten.

`openPit` opens an actual engine PIT and verifies the native physical identity before and after opening.
`retainPrepared` commits an immutable prepared row set, build and bigint generation owned by a new observation;
it does not assert population completeness. Each observation stores its own covered cut. Executions append only
under a durable active use lease and retain the original start plus original/terminal rows. Exact retries are
idempotent; different values under the same execution ID reject. Observation-only reads return execution:null.

Acquire precedes external engine work; release belongs in the producer's finally block. Leases expire at the
request deadline (at most five minutes) so process loss cannot permanently pin a PIT. Callers must enforce that
same deadline on external work. Close installs a durable admission barrier, drains existing leases and releases
only that observation's engine reference. Renewal probes the existing PIT and CASes its revision and tuple;
retirement and physical replacement never inherit retained coverage. No transaction spans engine I/O.
Factory disposal drains local calls; committed state survives recovery and supplied resources remain open.

The keyed joined read uses one SQL statement. Returned costs include SQL submissions, returned/affected rows,
encoded SQL/parameter/result bytes and engine requests, including failures and repeated drain work. Native plan
capture measures examined rows and blocks separately; counters do not claim returned rows equal examined rows.
This metadata must fit inside the consumer's existing whole-read budget; custody introduces no extra allowance.
Unknown custody remains pending for erasure/inventory. Complete coverage, all-role erasure, late-writer control,
Source permission, full consumer/default wiring and public disclosure remain their respective owners' work.
