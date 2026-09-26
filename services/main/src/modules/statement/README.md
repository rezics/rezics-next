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

`migrate-v1.ts` copies one exact current curated v1 Application head into an
identified Statement and qualified-fact DecisionSlot. The pending endpoint pages
at most 100 unconverted Applications. Cutover writes one profiled revision and
a successful receipt marker only when the graph guard finds no unconverted v1
head. The marker retires the v1 writer and makes public search and the v1
resolution adapter read Statement decisions. Retained v1 revisions and receipts
stay readable history.

Cost contract: one migration reads one Application/Sense/Decision tuple, validates
four profile focuses and commits one bounded graph update. The cutover guard
scans current v1 heads once; run it after draining pending pages. Classified
phrase search examines at most 256 candidate Main Versions and two exact
DecisionSlots per candidate. The rated joined path reads at most 100 standing
observations at the same graph position as its classified phrase relation and
fails when either bound or position is exceeded.
