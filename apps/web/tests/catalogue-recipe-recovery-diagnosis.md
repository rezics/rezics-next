# Original Recipe recovery: V2 diagnosis and V3 observations

Root's V2 run `run-1792421869618` reached the original recovered-method
assertion at `catalogue-detail-contract.e2e.ts:461` (selected runner line50) in
all four cells. Each failed after the original 5,000ms. Native prerequisites,
healthy identity, the injected fault, retained identity/type/title, no false
empty content, enabled Retry and disabled Cook passed. The cleared-alert,
recovered-read, bounded-retry, recovered-header and Cook/dialog assertions did
not execute. None is waived or counted as passing.

The [V2 receipt](../../../.temp/goal/recipe-recovery-original-v2/run-1792421869618/run-receipt.json)
has SHA-256 `b9366132b3bb851e1ac4a59698b53d59bd8e71a33c3388c6b80c814090e02a86`.
The manager's `recipe-recovery-v2-outcome-localization.json` packet has SHA-256
`32216815a62cde0c392053175a741d0be1bb283199fbe14cce54546d16c4b9da`.
All 45 frozen files matched and owned processes stopped. The backend, accounts
and genuine Artusi object remain unchanged. Preparation of this diagnosis sends
no HTTP request and starts no server or browser.

## What the saved evidence establishes

| Cell | Actual selected native observations | Retry response in saved Chromium trace |
| --- | --- | --- |
| Desktop/network | Four socket faults, then one genuine Recipe200 | RSC200 headers; completed stream and UI commit unestablished |
| Desktop/unavailable | One injected503, then one genuine Recipe200 | RSC200 headers; completed stream and UI commit unestablished |
| Phone/network | Four socket faults; no recovered Recipe GET | RSC503 HTML headers, followed by an actual document navigation |
| Phone/unavailable | One injected503, then one genuine Recipe200 | RSC200 headers; completed stream and UI commit unestablished |

For the three Recipe200 reads, the body is the genuine 12,820-byte response,
SHA-256 `0a5a425dee266f3521689cc777ed446106c4ff8798700249001daa6f94728d92`.
The relay has no timestamps. Its completed upstream body receipt cannot place
that completion before the browser's five-second deadline. RSC headers arrived
699–1,065ms after that assertion began; headers do not prove a decoded payload
or a React commit. The trace's missing body/receive completion and the UI's
retained alert/Retrying state leave that boundary unresolved. Untimestamped
`Network connection lost` server messages around shutdown do not establish the
cause of an earlier assertion failure.

Phone/network adds a concrete framework observation. `1-trace.network` records
the RSC request at monotonic34484.320ms, response503 headers about4,181.870ms
later, then a canonical **Document** request at38700.600ms. Subsequent document
asset loads occur after41726ms. This is a full document navigation during Retry,
not an observed recovered Recipe read. The saved response lacks a completed
body, so its exact server503 producer remains unestablished.

## Precise owner corrections

The existing Site/framework refresh owner should handle the live fetch's
`invalidRscPayload` decision for a failed **refresh**, alongside its existing
exception catch. In the installed `vinext/dist/server/app-browser-entry.js`,
lines1317–1322 execute `performHardNavigationForScrollIntent` for that decision.
`navigation-planner.js:83` classifies a503/non-RSC body as `invalidRscPayload`.
The existing patch at line1455 retains the document only when an exception is
thrown; the503 decision returns before that catch. Retain the current document,
settle pending state through the existing `finally`, and leave its real Retry
available on this failed-refresh branch. Preserve actual redirect and deployment
compatibility behavior. This correction alone does not prove recovery, explain
the upstream503, or explain the three RSC200 cells. No owner file is edited here.

The G2757 Recipe reader/shared transport owners should consolidate the existing
retry ownership. `server-fetch.ts` retries a lost read once, exposing an exhausted
`ServerTransportError` with `attempts: 2`. `recipePageReader` then retries that
503/Error a second time (`recipe-reading-recorded-page.ts:67`), causing two more
native GETs. HTTP503 does not take that nested path. These branches explain the
saved four-versus-one counts. Avoid repeating an already exhausted transport
retry in the Recipe adapter, while preserving the deliberate cancelled-owner
read recovery and shared transport semantics. The original `aborted <= 3`
assertion remains due; it was not reached in V2. No new retry budget is proposed.

## Narrowly missing completion observation

The separate owned successor
`.temp/goal/recipe-recovery-original-v3/` preserves the same product, dependency
digest, genuine object, fault socket/status, raw upstream piping, counter
computation, original timeout hooks and all18 original callback assertions. Its
selected callback SHA remains
`484b2fc125e9080f423077617cefc4f0d8dab784bb2f957cbba38d83fe7ed43b`.
V2's source, dependencies, 45 guarded files and entire saved run are checked
before and after preparation in `v2-custody.json` and remain untouched.

V3 adds observations only: actual native request arrival, upstream headers/first
byte/end, outgoing finish/close, selected evidence and relay phase/IPC
acknowledgement; Chromium RSC/document request, headers, received bytes,
loadingFinished/loadingFailed; completed RSC body inspection; passive DOM
identity/method/alert/button state; and expect-step start/end timestamps. The
native log includes sibling reads to distinguish address/header503 from Recipe
execution. Recovery responses are not substituted and no completion count is inferred from
a click, headers or DOM presence. Body inspection uses Chromium's completed
response, adding no application request. DOM method observations use rendered
text in the original named Recipe region, excluding serialized scripts and
hidden content. No observer waits for body completion,
polls, navigates, adds an assertion, or extends the five-second deadline.

`observation-delta.json` reconstructs each changed executable from its frozen V2
source; `observation-delta.patch` exposes those changes and the added observation
fixture. The browser fixture import
changes outside the literal callback. The accepted relay remains saved with its
original hash; its executed derivative adds observations around unchanged native
operations. `verify` checks this derivative separately, all original literals,
the unchanged assertion ledger, the source/dependency/font hashes and current
compatibility receipt. No product acceptance is inferred from static checks.

`selected-frontend-compatibility.json` compares the exact frozen
`05c9534e958f0c67de2e5662281ef22c2864fe95` with manager-named Main
`58454cf4c097c26c006b8a6e69bf63aacf7b6699`. Recipe reading, shared Work loading,
API transport, address/proxy/worker, the existing framework patch and dependency
inputs match. The unrelated Anime relation file differs. This qualifies the
selected frontend, without asserting whole-product equivalence or requiring a
new catalogue, actor or backend revision. This receipt checks 274 identical
files. Preparation took30.4s; the final manifest freezes51 package files and
the unchanged18-assertion ledger. Focused types, runner/spec builds, exact
four-test collection and documentation checks are stack-free; V3 runtime
remains unexecuted.

Root may run the following **once for the missing completion observations**, or
coordinate the owner corrections first. This preparation does not execute it:

```sh
GOAL_ID=audit-remediation-20261019 task --taskfile .temp/goal/recipe-recovery-original-v3/Taskfile.yml run
```

Run from the G-2774 worktree in the manager session. The embedded browser Task
keeps ordinary `scripts/goal/admission.ts`; no job attaches to an exited worker.
The same four selected visitor cells execute serially at1440/390. Interpret the
new evidence by comparing native completion, Chromium completion, the original
expect interval and actual DOM state. A native200 with an unfinished RSC, a
completed RSC without the method, and a completed method-bearing RSC without UI
commit are distinct owner boundaries. Missing completion remains missing; it is
never reported as success. Existing Book/C27/Source work stays independent.
