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
