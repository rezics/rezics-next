# Realm ranking SQL ceiling

The 20261011t224103-6e152a profiles contain 45 PostgreSQL statements for an
anonymous ranking read and 50 for a member read, at every 100/400/1600 cut,
Best/Top order and first/warm read. The existing ceilings are 44 and 49.
Physical dispatch counts and trace counts agree. Anonymous spans comprise
Access36 + Content8 + Relay1; member spans comprise Access41 + Content8 + Relay1.

The extra statement is:

```sql
SELECT stream_scope, data_epoch, sequence::text AS sequence
FROM relay.checkpoint WHERE consumer = $1
```

It is issued by `RelayHandoffPositions.read()` in
`services/main/src/modules/outbox/relay-position.ts:32–34`. The new ranking caller
is `mainStreamCoverage()` in `services/main/src/modules/rankings/realm-threads.ts:64–76`,
called at line146. Its sequence becomes the ranking admission query's `$10`
at line189.

The 44/49 ceilings were introduced by main commit
`b96001c693be58aabac93fcf6ef2448f7494e1b6`, “Realm: index complete Best and Top
populations and bound header reads” (2026-10-04). Main commit
`4634362af683d0463f68ee3f7dbe9230cf812446`, “Fix Realm ranking stream admission”
(2026-10-11), subsequently added this ranking call. Before that change,
admission compared the retained Main stream checkpoint with the graph sequence.

The statement is required by the current stream-position contract. A graph
revision can advance independently of Main outbox delivery. The lookup proves
the consumer's current Main stream coverage and validates its stream and epoch;
the page then checks that the ranking projection covers that position.
`WorkReadSession.position` and its opening/closing position probes carry graph
positions, so they cannot substitute for this relay lookup. The owner test
`services/main/tests/realm-ranking-stream-position.test.ts` explicitly exercises
graph sequence100 with Main coverage3 and ranking checkpoint3, and rejects
foreign stream/epoch, real lag and pending effects. Removing the lookup would
restore the repaired position-domain defect.

Relevant Access disclosure history on main was also examined.
`c731a1b4dcd3892e5e16856cb2af27198575122f`, “Keep community reads inside their
request caps” (2026-10-09), removed redundant disclosure work before the relay
repair: repeated graph name-owner probes, a repeated admitted Realm-policy
read, and duplicated lineage/opening checks on New. It does not introduce this
extra Relay statement. The observed +1 applies identically to anonymous and
member reads, matching the newly added common ranking call.

The older profile artifact has operation/database/span identity, not SQL text.
The attribution above combines its single Relay SELECT, dispatch order and the
introducing source diff. The profile child now retains each request's physical
SQL template and database, without parameter values or additional dispatches,
so the next retained-corpus run can verify the statement list directly.

The retained-corpus rerun `20261011t232333-ad92f4` verifies all 24 SQL lists:
each list has exactly as many statements as the physical dispatch counter,
including exactly one copy of the Relay checkpoint statement above. At every
cut, sort and temperature, anonymous reads remain 45 and member reads remain
50. Both counters are exactly constant across 100/400/1600; their unchanged
absolute ceilings still fail.

The G1034 ceiling owner in launch must decide whether to accept the required
statement's budget or obtain a real owner optimization. This worker leaves the
44/49 ceilings, growth classes and margin unchanged and changes no product code.
