# Native API contract pilot

Decision, 2026-10-15: retain native Elysia contracts, separately checked handlers
and domain-owned Problem declarations for the Work header, Work-create acting
context preference and Work scalar command. Expand selectively by domain after
its failure paths are proved. Do not schedule a mechanical route-wide rewrite or
claim a compiler speed improvement from this pilot.

The useful change is stronger evidence at the boundary: a wrong success body or
undeclared error code now fails compilation and runtime response validation;
Eden retains the several literal 409 alternatives. Separating files alone did
not achieve that. Explicit response schemas, checked native returns and the
domain's status/code/schema declaration did. An error class still needs its
schema companion. The smallest helper constructs that envelope; it does not
register operations or infer schemas from classes.

The production policy owners remain authoritative. The auth macro invokes the
existing current Account verifier; scalar admission and public-read sessions
keep their own verification order. Exposure and budget options publish the same
contract policy consumed by the existing composition-root enforcement. Public
reads remain exempt and writes charge once. Mounting another budget plugin in
each policy factory introduced an import cycle in the operation-index entry
point; the pilot instead uses the already-mounted owner. Native policy metadata
does not replace owner authorization or command/idempotency orchestration.

Keep the OpenAPI generation overlay. Both the installed OpenAPI beta.4 and the
spike's beta.6 replace authored per-status details. Native schemas describe the
bodies; the overlay still preserves the existing Problem media, security and
Idempotency-Key publication. The pilot adds no routing abstraction and keeps the
implementation-derived MainApp export.

## Measured tradeoffs

Baseline source: `403c39d0b54a6e8ab4e21241b489c8390b64d9f2`. Measurements use Bun
1.4.3, TypeScript 7.0.2, Elysia 2.0.0-beta.16, Eden beta.5 and OpenAPI beta.4.
The [pilot runner](../../scripts/api/native-contract-pilot.ts) uses the
[spike's compiler runner](../../scripts/api/native-contract-spike.ts) and the
[boundary audit](../../scripts/api/boundary-audit.ts). Disposable observations
are under `.temp/contract-pilot/{before,after,scratch}`.

The line count is the original inline binding span versus whole new contract
and handler files, including imports and blank lines. Original shared schemas
and error helpers are outside that span. After declarations count top-level
variables, functions and type aliases in the two new files. This deliberately
shows the new explicit cost; it is not a claim of equivalent-work LOC savings.

| Operation | Before inline lines / bindings | After contract lines / declarations | Handler lines / declarations | Binding lines / bindings |
| --- | ---: | ---: | ---: | ---: |
| Work header GET | 7 / 1 | 38 / 4 | 33 / 2 | 1 / 1 |
| Acting-context preference PUT | 20 / 1 | 38 / 3 | 25 / 2 | 2 / 1 |
| Work scalar POST | 28 / 1 | 40 / 3 | 36 / 2 | 1 / 1 |

The seven new domain/envelope modules and shared policy factory add another
205 lines. The central mapper and old Work-read helper now delegate the moved
failures for legacy routes. Three operations still have three contracts, three
handlers and three native bindings; schema models are references, not another
operation registry. The operation index follows imported native bindings,
including aliases. The audit's local handler walker explicitly reports these
three imported factories as unanalyzed; its response evidence remains a
syntactic lower bound, not a substitute for their runtime tests.

The audit's original scratch error changed two production files and one proof
file: domain class, central mapping, test. Repeating the experiment with a new
`preference_repair_required` 409 changed **one production owner file and one
proof file**. Its class, declaration, schema alternative and translation stayed
in that owner; the existing contract reference carried it into OpenAPI and Eden.
No handler, binding or central mapping changed. QA `20261015t100612-ad200a`
passed 14 tests/131 assertions, including literal Eden discrimination and a
runtime response from the actual preference binding. The runner restored both
files in `finally`; the scratch failure is not installed.

The generated comparison dereferences schemas and ignores property order and
schema IDs. All 791 declaration entries, 779 documented operations and 709
paths remain. Only 23 error responses change: 21 existing envelopes acquire
literal-code precision and the two commands gain their existing runtime 429
response. There are 27 new named schema components. Operation IDs, request
schemas, success responses including 202, parameters, security, exposure,
headers and media are equal to baseline; unrelated operations are equal after
dereferencing. Every alternative of an existing Problem response must refine
its old envelope. Tests reject changed media, headers, missing extensions and
widened codes. The captured UTF-8 document grows from 30,688,751 to 30,717,541
bytes (0.094%). This includes reference representation and formatting, so it is
separate from semantic equivalence. The reference-aware audit counts 25 literal
error responses, 5,300 broad ones and two non-Problem bodies across the whole app;
this pilot does not claim whole-app literal coverage.

| Compiler workload | Before wall / check ms | After wall / check ms | Before instantiations | After instantiations |
| --- | ---: | ---: | ---: | ---: |
| Full Main, including owner tests | 21,583 / 18,154 | 22,095 / 18,404 | 20,722,877 | 21,154,720 |
| Matched original Eden fixture | 13,494 / 11,876 | 14,158 / 11,865 | 12,154,275 | 12,330,804 |
| Eden fixture plus new discrimination proof | same original baseline | 13,996 / 11,734 | same original baseline | 13,903,588 |

The table records one baseline and one final observation on a shared host,
not controlled latency estimates or an aggregate of intermediate verification
runs. The matched consumer uses the original fixture without the
new proof import. Its instantiations grow 1.45%; full Main grows 2.08% and also
checks new tests. Adding the proof grows the consumer workload further, so that
row must not be attributed solely to route representation. The unchanged Eden
30-second gate passes at 16,713 ms; web type checking passes. There is no evidence
here for faster editor completion, startup or declaration-bundle emission.

## Qualification and expansion

The native unit checks reject invalid success bodies for all three contracts
and an invalid 409 code, preserve separate same-status failures, validate headers
and opaque fallbacks, and verify one write charge and the read exemption.
Type checks prove literal codes through model references and the real MainApp
Eden consumer, including exhaustive scalar-conflict handling and 200/202
discrimination. Baseline fingerprints keep requests and success schemas fixed.

QA `20261015t094251-777556` passed the acting-context integration, scalar
write/replay/omission/access/stale-head integration, concurrent read fences at
0/8/32 writers, anonymous/ordinary public-read matrix and 18 book outcome cases.
Its owner tests passed 14 tests/121 assertions. That combined run remains
**failed**: `services/main/tests/work-read.integration.test.ts:353` calls the
absent, unchanged `POST /v1/classification-decisions` and expects 201 instead of
404. The isolated retry reproduces it; the endpoint is absent in the captured
baseline too. Earlier header/public/private assertions and the credits case
passed, but assertions after that unrelated call are unqualified.

QA `20261015t101211-b61dc1` additionally proves scalar 202 on real Account,
Access and Jena: a database trigger refuses Access settlement after the graph
commit. The response retains its operation identity, retry and JSON media; after
the fault is removed, the same key returns 200 with the same revision and no
additional graph effect. No owner method is mocked in that test.

Final validation: `task gen` was reviewed through the normalized OpenAPI
comparison; the Eden gate, `task web:typecheck` and `task docs:check` passed.
`task goal -- check` job `becc1b36-4ee7-4668-9a2b-8a2519a3d8dd` passed types,
type-aware lint, AST and all selected repository guards. Its test section names
no brief tests; the explicit QA runs above supply route evidence. The earlier
guard finding about imports through Access implementation files was fixed by
exporting the failure surface through its existing composition entry point;
no dependency-debt exemption was added.

The recommendation is to expand to one coherent domain at a time when its
distinct failures and adverse-state regressions can be named. Keep failure
families at that owner so a new same-status code needs no route coordination.
Retain native binding, session/disclosure checks and pending-command semantics.
Treat the extra explicit code and modest matched-consumer inference growth as
costs of precision; do not convert streaming, conditional or proxy replies merely
to remove Response. Before a broad expansion, extend imported-handler audit
coverage, repair the stale classification fixture through its owner, and compare
the same consumer workload again. A compact exported client contract remains a
separate experiment, rather than an inferred benefit of file separation.

Reproduction (run long commands through the Goal job mechanism):

```sh
task goal -- job -- bun scripts/api/native-contract-pilot.ts capture .temp/contract-pilot/after
task goal -- job -- bun scripts/api/native-contract-pilot.ts compare .temp/contract-pilot/before/openapi.json .temp/contract-pilot/after/openapi.json
task goal -- job -- bun scripts/api/native-contract-pilot.ts scratch .temp/contract-pilot/scratch
task goal -- job -- task gen
task goal -- job -- bun scripts/api/eden-gate.ts
task goal -- job -- task web:typecheck
task goal -- job -- task goal -- check
```

Capture `before` on the baseline revision before applying the pilot. The
runner's `lines` action also measures retained original route-source snapshots.
The source-linked baseline fingerprints are committed with the tests; bulk
OpenAPI and compiler logs remain disposable. Native design references are
[Elysia's macro documentation](https://elysiajs.com/patterns/macro) and
[typed status/headers guidance](https://elysiajs.com/essential/handler);
the pinned-package probes and production regressions establish applicability.
