# Statement operation template

`graph.ts` records an identified `rdf:Statement` and writes one exact acceptance
decision slot. `read.ts` returns the statement with its readable meaning basis
and resolves local then Global acceptance. The shared graph command and receipt
path is `../context/command.ts`; the route adapter is `../../routes/contexts.ts`.

For another Statement mutation, copy the request digest, exact meaning key,
expected-head and target guards, profile validation, receipt resolution, and
read path from these files. Retain independent speaker, support, evidence and
decision identities; a Context or decision change never rewrites a recorded
statement. Qualify each extension through a real write/read test and its own
bounded cost contract.

Catalogue import records direct Concept and exact-definition references as
Statements and acceptance decisions in its existing bulk transaction. Readers
use that representation immediately; the old classification writer is retired.
Retained Application revisions, manifests, operations and receipts remain
historical evidence.

`seek.ts` maintains reference coverage by data epoch and contiguous graph outbox
positions. Subject reads seek ordered candidates in Access before bounded graph
hydration and acceptance resolution. Missing, stale or incomplete coverage
answers unavailable. Frame reference postings preserve specificity order and
independent Statement identities, including speakers with the same meaning.
Classified
phrase search examines at most 256 candidate Main Versions and two exact
DecisionSlots per candidate. The rated joined path reads at most 100 standing
observations at the same graph position as its classified phrase relation and
fails when either bound or position is exceeded.

Run `task dev:refresh` to upgrade a populated stack. Its `prepare-storage` step
calls `prepareDevOwners` → `migrateOwnerData` → `upgradeStoredStatements`, after
applying Access migration 1300 and while Main and Relay are stopped. The owner
step settles legacy admissions, takes both recovery fences, converts retained
decisions, rebuilds seek coverage and verifies the exact graph position before
releasing its fences. Failure prevents restart; retry resumes the upgrade's
own durable fence marker. It refuses unrelated recovery holds. A completed
upgrade is a no-op in the same data epoch. Install upgrades use the same owner
step. `task statement:convert -- --fenced` remains available to operators who
already hold both recovery fences.
`populated-conversion.ts` uses exact retained manifests, preserves the public
proposer/decider and original operation, and writes an idempotent maintenance
receipt per current legacy head. It keeps all old revisions and provenance.
An interrupted run resumes from those receipts. It activates rebuilt seek
coverage only after conversion completes. Main startup performs no backfill;
owner storage preparation completes the conversion before Main starts.

Recovery recreates Statement acceptance from retained receipts. Rebuild seek
coverage explicitly in every restored data epoch before releasing its hold.
The constants beside conversion and seek code carry batch and response bounds;
an unprovable source position leaves coverage unavailable.
