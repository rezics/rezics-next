# Native cover recovery evidence

The frozen binding is [cover-native-recovery.test.ts](../../../services/kernel/test/imports/cover-native-recovery.test.ts),
with [cover-native-recovery-fixture.ts](../../../services/kernel/test/imports/cover-native-recovery-fixture.ts).
It preserves the existing local recovery regressions and repaired coordinator without changing product code or
existing tests. This report's file-existence acceptance is separate from native execution and promotion.

Frozen scenarios:

- `native new-cover acknowledgement survives interruption before local deferred completion`
- `native changed-cover acknowledgement survives interruption and subsequent replacement remains correctly credited`
- `a fenced cover during native recovery is never restored while adjacent unfenced facts remain readable`

## Binding and fault boundary

`openApiRuntime` owns native Auth-issued account-key credentials, ordinary editor password credentials through
`openApiObserver`, real Access, the public kernel transport, native stores, registered content jobs, Sharp and
external object-store fixtures. An isolated real `Importer`/`ImportSession` uses the same public transport and its
own SQLite file under `os.tmpdir()`. No authoritative SQL writes, permission callbacks, alternate worker engine,
fake receipt or invented subject/candidate/media ID is used. The runtime command map only supplies bounded
receipt locators to its existing observer; actual receipts are independently read from `core.receipt`.

`createSourceRegistration('bangumi')` converts the pinned Bangumi subject. `createMediaResolver` persists the real
202 reservation and reads actual reserved state before any job delivery. Its initial `deferPending` pass remains
pending; only its subsequent status port drains the existing native boundary with one media ID and `maxJobs: 16`.
This avoids relying on the runtime's eager resolver. No deadline, policy or production scheduling change is made.

The existing `afterBulkSuccess` callback captures successful native command acknowledgements and reads their
persisted native receipts. Immediately before the real `RunStore.resolveDeferredCover`, the one-shot interceptor
checks the actual local candidate and persisted SQLite acknowledgement, aborts and throws. It does not write an
effect or synthesize authority. The same SQLite file is closed/reopened. Recovery requires the exact original
proposal, candidate and receipt, no retraction of that acknowledged cover, no duplicate reservation and no effect
on identical replay. Older candidates remain eligible for ordinary reconciliation. Cleanup restores the method
and closes partial opens, the importer, native runtime/worker and temporary SQLite directory on failure.

## Disclosure and limits

An ordinary editor accepts and adopts actual returned candidates in the Global Context through the existing API.
Anonymous reads use `/v1/subjects/{id}`, `/v1/media/{id}:authorizeDownload` with an actual available variant and
`POST /v1/pages:read` with `{target:{subject:id}}`. The page assertion inspects its actual subject sub-read.
Original bytes remain unavailable publicly. Credit must be `(c) rights holder via Bangumi`, with independent
`LicenseRef-unknown` image licence and original record/image references. Summary rights retain their independent
producer contract; a URL does not establish a metadata licence.

Replacement uses distinct configured provider URLs and actual new media reservations, then explicitly selects
the replacement via editor acceptance/adoption before asserting public presentation. Source retraction is never
assumed to erase community adoption or old media bytes. The existing boundary emits the same valid deterministic
PNG for its normal source URLs. Thus these assertions discriminate reservation/provenance/replacement identities,
not distinct replacement pixels. If distinct image content is required for an additional witness, the exact minimal
fixture seam is an optional encoded-byte input to `MediaBoundary.source` in `test/imports/media-boundary.ts`;
it is outside this task and has not been silently added. No native success is inferred for that absent witness.

The fence case uses real media takedown and the exact source-record-cover tuple fence between interruption and
restart. Subsequent final anonymous subject/page disclosure must hide the cover, downloads must deny, and adjacent
selected name/summary facts remain readable. This makes no cross-partition atomicity claim or claim about every
consumer. Catalogue/search, curated/Everything/state Collections, mounted Zones, configured TypeLists and served
web HTML/common-cover publication still need their separate native consumer matrix and authority variants.
General source-record attribution/licence production is separately pending with Semantic; this suite fabricates
neither its ABI nor an I2 attribution pass. The unrelated import-to-discovery capability remains open.

## Cost and inspected sources

One fixed selected record/run, at most three actual provider URLs and media reservations, exact receipt keys and
candidate pages capped at 100 bound the fixture. It does not enumerate total source/history, add polling or replace
existing pipeline caps. Existing growth suites remain evidence only for their measured paths.

Read: the complete [API acceptance audit](../api-acceptance-gaps.md); Imports Goal and capability manifest;
importer recovery/deletion/cost contracts; Content covers, source fences and download contracts; Access grant,
Global governance and credential rules; Semantic candidate/accept/adopt and page HTTP schemas; existing local
`deferred-cover-recovery` and extra regression; `api-runtime`, `api-observer`, `api-fixture`, `media-boundary`, its
observer and native content media fixtures; production resolver/coordinator/bindings; Bangumi converter and pinned
subject fixture. No external reference implementation supplies this recovery surface, and none was copied.

## Execution

Native command (one final execution):

```sh
bun run --cwd services/kernel check test/imports/cover-native-recovery.test.ts
```

At source revision `facb2d0b1d7431227815e423f7e3c10eeba694bb`, the final command exited **0**:
**3 pass, 0 fail, 326 expect() calls**, three tests in one file, no skips/todos and no load reruns.
Bun reported `1.4.4-canary.1 (a0cc096ce)`. Scenario durations were 11,618.59 ms, 10,650.32 ms and
9,624.81 ms respectively; Bun's test duration was 55.83 s. The focused check also passed its compiler gate.
All three scenarios reach the native ACK/local fault and their subsequent disclosure assertions. The repaired
coordinator already satisfies this native evidence slice: no product failure is manufactured and no implementation
change is needed for these cases. Main/promotion and the remaining consumer matrix are not established.

Earlier authoring checks are not concealed or counted as native product failures:

- The first focused invocation failed its compiler gate with three `TS2339` errors accessing `content` without
  narrowing the statement value union. Zero scenarios ran. Explicit value/reference guards corrected the new tests.
- The first actual scenario execution had **0 pass, 3 fail, 214 expect() calls**. Its first failure was
  `Expected: false / Received: undefined` in `disclose`, checking a denied original download as a successful
  `{allowed:false}` body. The existing production route and existing media HTTP tests require `404 not_found`.
  The new assertions were corrected to that actual schema, including fenced-download denial; existing/frozen tests
  were untouched. Native crash/recovery and available-variant disclosure had already been reached before this
  fixture expectation failed. The final run additionally checks publicly selected original source references.

Required root command `bun run typecheck` ran once and exited **1** on the earlier snapshot, with exactly the
same three new-test `TS2339` diagnostics; all other workspace results passed. The corrected final kernel compiler
and three native cases passed in the focused command above. The root command was not repeated, so this report
claims no final whole-root green result. No extra full-root/kernel/module gate ran. Initial shell log redirection
failed because `.temp/` did not yet exist; creating the directory preceded actual command execution.

Decisions: use ordinary Global acceptance/adoption rather than relying on imported proposals being selected;
model pending state by withholding bounded job delivery until the deferred status pass; keep source URLs and native
reservation identities distinct while reporting the existing source fixture's identical-pixel limitation; use the
production 404 denial schema. No files outside the four declared paths changed.
