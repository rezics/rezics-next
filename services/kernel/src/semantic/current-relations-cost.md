# Current relation visit cost

`currentRelationFacts` accepts at most 500 distinct requested keys. The mounted inverse and forward relation pages pass
at most their 100-row page window. Let `U` be those keys, `H` the current slot, adoption and acceptance heads read for
expanded slots, and `C` the selected live candidates. The work is `O(U + H + C)`: each key is probed directly, a
compact slot has at most 33 fact-log rows, and each expanded selection admits at most 32 candidates. The selected
candidate and history budgets are the native limits; unrelated Subjects and obsolete revisions add no term.

The retained native stack run `67948204-8af7-455b-89d2-6952bf2460a6` used source
`9a019391f3e547a236d78f78fc2b953c62f6445d` and command `services/auth/scripts/dev-stack.ts start`. Its six anonymous VN
`/relations` and `/links` reads returned HTTP 503 `deadline_exceeded` at 1,165–1,174 ms in `before_command`; access
preparation and transaction phases were zero. This establishes a pre-command request deadline, not its precise startup
or scheduling cause. SQL candidate counts are separate readbacks and do not establish successful native page responses.

The live-candidate statement batches `U` JSON keys and point-reads candidate primary keys. When the caller supplies a
slot, its compact fallback reads the latest `(route, subject, slot, statement)` fact through
`fact_current_relation_key_seek`; an inverse caller without a slot uses the existing
`fact_statement_identity` key. One compact statement batches the remaining active keys, point-reads each Subject,
slot head, exact statement fact and recording revision. The revision lookup uses the existing recording-transaction
index. Compact disclosure and provenance each use one bounded batch; provenance batches are at most 256 keys and
source-fence batches at most 100 tuples.

For each unique expanded slot, the existing `slotView` reads the current slot head and adoption head, then the
selected candidates by key. A Context that inherits Global selection also checks at most 32 current acceptance heads.
This fallback keeps its native per-slot and per-selection limits. Missing current heads do not trigger a history walk.

The common path uses two SQL statements for live and compact lookup, one for compact disclosure when there are compact
results, `ceil(U / 256)` provenance statements, and up to `ceil(U / 100)` source-fence statements when candidates have
external sources. Queries stay on the caller's repeatable-read client; this function opens no connection and adds no
transaction controls. Expanded fallback adds the existing slot/adoption/selection statements and at most 32
acceptance point statements per inherited slot. For actual
page completion, `currentRelationStatements` sends all selected candidates in one keyed current-read statement,
including the source home on each key. One authoritative partition-metadata batch binds those homes on the same
repeatable-read snapshot; every SQL locator retains its exact home range. `readAnchoredFences` still opens one checkout
per distinct source partition and 100-tuple batch, with BEGIN and COMMIT controls; those batches are independent of
Subject population.

Decision: HTTP relation and link reads carry the original request deadline through release resolution and page reads.
Read snapshot and source-fence checkout and SQL obey that deadline. Freshness polling uses at most half the remaining
request time; if it expires, the response reports `caught_up: false` and leaves the remaining budget for the current
page read.

Decision: a relation page verifies all selected source homes in one batch and hydrates current statements in one
same-snapshot keyed read. Each key retains its route and home range; disclosure and source-fence checks remain current.

Input bytes are linear in `U`: route integers, UUID keys, property/context IDs and bounded defaults. Provenance batches
carry at most 256 route/Subject/candidate/slot UUID tuples. Expanded output carries at most 32 selected statement
payloads per slot, under the existing statement and qualifier limits. No helper performs an uncharged catalogue scan.

`test/semantic/growth-current-relation-visit.test.ts` captures keyed plans and examined rows at 64, 512 and 4,096
unrelated Subjects while current keys stay fixed and obsolete revisions on the selected Subject grow. The controller
runs the native acceptance after integration; source inspection is not recorded as a measured pass.
