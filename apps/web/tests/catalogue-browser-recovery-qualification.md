# Original catalogue browser recovery qualification

Status: source and saved-receipt qualification only, 2026-10-19. The proposed
[test relay](catalogue-recipe-fault-relay.ts) is executable source, has no import-time
effects, and has not been started. The original callbacks, helper and all acceptance
assertions remain unchanged. Manager review of the transport/trigger equivalence
below precedes any callback adaptation or browser execution.

## Frozen authority and evidence

The original specification pin is `a0c6558fddc430e3164297970865a69b02fb015d`.
These SHA-256 values still match this worktree, including the frozen originals in
root's `trace/a08-recipe-recovery-readiness-v1/originals/`:

| Original | Bytes | SHA-256 |
| --- | ---: | --- |
| [Recovery block, lines 428–474](catalogue-detail-contract.e2e.ts) | 2934 | `17989f3e7941a56341c979670e02741de12c064664af7fc15ec849957a95321e` |
| [Complete detail test](catalogue-detail-contract.e2e.ts) | 32565 | `b6889bcde1f06083da74aa0507f85c35a91627a80dea75cb9e3f586b8ebfa2c3` |
| [Complete report test](catalogue-report-selection.e2e.ts) | 16633 | `68a2570a5e68a56e40dbc163db500ef08082a4ad019e22b27fb91aacf250d129` |
| [Complete fixture helper](catalogue-browser-fixture.ts) | 22034 | `6a64ca9e45e3353bd4dd2df53e89d78d859e90a96264f31d785795514c4611e0` |

Evidence paths below are relative to the read-only main-checkout directory
`.temp/audit-remediation-20261019/two-hour-sprint/`. They identify existing saved
receipts; this continuation issued no application requests, browser runs, service
starts or corpus operations.

| Receipt | SHA-256 | What it establishes |
| --- | --- | --- |
| `trace/a08-recipe-recovery-readiness-v1/readiness.json` | `c5b14ac2e96818c64cf74b914e39d1cb79cdc1cf39d6e4d952822cd62dfb5501` | `NOT-ADMITTED-NO-RUNTIME`; no genuine browser GET trigger for the original two Recipe fault cells |
| `catalogue-A16-existing-fixture-qualification.json` | `70ad566335c44088f9687e17ffadb594282b88d1f3fcaf411b1c0f165e2a7c3a` | Book owner creation exists; selected owned post/reply and real-image coordinates are missing from inspected bindings |
| `site-I1-001-A08-original-acceptance-20261019T115406Z.json` | `1550e2c789b3e55b1d8aa6d89b14c2f20ca2ad25ef8bc32e51ba4f1814114d51` | Existing actual SSR 503 at `c66950b774beef9727ad5f1a9142cf425b992fb8`, width 390, preserved Recipe/disabled Cook/Retry; successful recovery was not executed |
| `trace/a18-positive-v2/run-5a99c7d18979-desktop-1792406419475/run-receipt.json` | `6ad34b835f68b618d3c3b02d6e290df05c148b2358120fbe9b1a85239c5c5460` | Genuine positive Cook at `5a99c7d18979ebed15fca6ac6ef60b55ec9d68f4`; separate from fault/recovery |
| `trace/a18-positive-v2/run-5a99c7d18979-phone-1792406528269/run-receipt.json` | `e721d180247cc38bd44972fd49b868551e716112789915fbbd93383f2c67fe89` | The same positive at width 390 |

The failure receipt and the two positives remain separate. Combining their
results does not establish successful Retry of the failed object. No original
Recipe network/recovery body reached its outcome assertion in this continuation.
Absence of an admitted runner is a harness premise, not a product failure.

## Actual boundary and selected fixture

Use the current-compatible product qualified by root at
`8d5a550fc6ca47f756a347165bb61f89156ac18a`, whose exact source snapshots accompany
the readiness receipt. This worker's inherited product source is older; it is
not a requirement to restore that older product. The frozen current
`recipe-reading-recorded-page.tsx` hashes to
`1ef6ca2fead2b3a24f1862ed702911f9c11f7664dde41cf8eb9b6b6987d70095`.

At that pin, request-cached `initialRecipe` calls the real server Main client for
both frame and body. A failed answer renders `RecipeReadFailure`, a named Recipe
region with an alert and Retry. `canCook` follows that same answer. Retry calls
`router.refresh()`, causing another RSC render and server Main read. The frozen
`retry-button.tsx` hash is
`fa3ccf6b30c00d924caf78b4401aa902b80262bf2ac0f206c325363f4378006e`.
The existing G-2757 owner retains this product behavior; this patch changes none
of its source.

The original `page.route` is installed after a healthy `publicSubject` visit.
It can observe a browser `/api/main/...` request, but neither the initial server
read nor the server read caused by Retry traverses that browser route. Cook
dispatches a local event/hash navigation. Scale requires a positive servings
measure, and Show more requires a continuation cursor. Neither is present for
this genuine complete Artusi recipe. Browser route interception of the outer
document/RSC response would fail a different boundary and cannot demonstrate
the local Recipe failure while preserving its successful identity/context.

G-2791's qualified retained inputs are sufficient for these two Recipe cells:

| Binding | Exact value |
| --- | --- |
| Backend as recorded, not probed here | `http://127.0.0.1:46775` |
| Backend / support overlay pins | `4a616b079a364b8f5ac7fe4d4ff56bc99849e766` / `1f1032cc60369a69bb07695b1b37e6a409c0ac56` |
| Generation | `recipes-build-mveymfp0-c3acb7` |
| Work UUID / semantic type | `01a1532a-2e60-7260-9f3a-d6aa69f61c4b` / `https://schema.org/Recipe` |
| H1 | `21. Minestra di passatelli di carne` |
| Structure / revision UUIDs | `3eda0717-be08-826b-b86f-f5a69d644d1a` / `8794fe94-aad8-872c-aad4-cf5ff5ce50aa` |
| Server / browser API path | `/v1/recipes/works/01a1532a-2e60-7260-9f3a-d6aa69f61c4b` / `/api/main/v1/recipes/works/01a1532a-2e60-7260-9f3a-d6aa69f61c4b` |
| Region / unavailable text | `Recipe` / `This part of the page could not load. The rest is unaffected.` |
| Recovery text / first genuine step | `Il filetto pestatelo nel mortaio e passatelo dallo staccio.` |
| Step occurrence UUID | `c1b62a59-a93d-8db8-98f3-87c541fcfca1` |

There are eight genuine ingredient lines and eight native `recipe-step`
occurrences. The direct `instructions` and `measures` arrays are empty and
`next` is absent. Bind `corpus.recipe.steps[0].text` from the genuine active
occurrence's `qualifier.instructionText`, retaining its source key and introduced
revision. Do not synthesize instructions, measures or another page. The saved
real Recipe answer SHA-256 is
`0a5a425dee266f3521689cc777ed446106c4ff8798700249001daa6f94728d92`.
The existing backup SHA-256 is
`7f6d8d7645e870959b050028d53ed1b7997c243065f236915af13db2720b09ca`;
no backup/restore/import is needed for this qualification.

## Proposed transport correction for manager equivalence review

The smallest proposed correction uses the new test-only relay as the isolated
frontend's `MAIN_ORIGIN`. It faults only the exact native Recipe GET. Other reads,
including Main's declared body-bearing reads, pass through to the existing
backend. Commands are refused. Healthy and recovered bodies are raw upstream
responses; the relay records actual request method/path/query, phase, status,
response byte count and SHA-256, without credentials or response-body logging.
No UI control or product API is added.

This is a change to **transport observation and the initiating browser gesture**,
not a claim that SSR emits the original browser `/api/main` GET. The original
literal trigger and interception cannot both hold on this product. The following
equivalence is proposed for manager review, not silently applied:

| Original observation/outcome | Proposed observation preserving the same outcome |
| --- | --- |
| Healthy `publicSubject`, real typed page API, exact header identity/type/H1 | Run the same helper and assertions against the genuine object before arming; require an actual healthy Recipe 200 through the relay |
| Click an existing healthy read trigger after installing the fault | Arm the relay, then use Playwright's real `page.reload({ waitUntil: 'domcontentloaded' })` on that same canonical Work URL; this triggers the existing SSR read, without a product Reload button |
| Exact pathname and `GET` assertion | Record actual server ingress at the exact native pathname; the `/api/main` BFF prefix is the only path mapping. Keep the GET assertion against those actual receipts |
| `route.abort('failed')` or exact 503 error JSON; `aborted > 0` | Destroy the real incoming Recipe HTTP socket, or return the original 503 JSON. Count only actual faulted Recipe GET receipts, never reloads, actions, manual probe requests or expected counts |
| Named region alert/unavailable text; no false empty/missing/unnamed text | Keep every existing region/content assertion literally |
| Stable header resource/type/H1; enabled exact Retry; disabled exact Cook; no Want to read | Keep every existing assertion literally; forward sibling reads unchanged |
| `fail = false`, then click Retry | Set the relay to recovery, then click the existing exact Retry. Its real `router.refresh()` must issue the successful server read |
| Recovered text, alert gone, `recovered > 0`, `aborted <= 3`, stable identity/type | Keep all original assertions. Derive recovered counts only from completed real 200 responses; recompute fault counts again before the final bounded-retry assertion |
| Enabled Cook opens exact Cook dialog containing `corpus.recipe.steps[0].text` | Keep the original click/dialog/content assertions, with the unchanged genuine step binding above |

The executable adapter interface for the existing selected-original runner is:

```ts
const relay = await startCatalogueRecipeFaultRelay(
  admittedMainOrigin, '01a1532a-2e60-7260-9f3a-d6aa69f61c4b');
// Existing isolated frontend launcher: MAIN_ORIGIN=relay.origin.
// Browser baseURL stays the isolated frontend, never relay.origin.
try {
  await publicSubject(page, fault.subject); // Original helper, unchanged.
  relay.arm(transport);                    // After the genuine healthy read.
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Original failure/identity/Retry/Cook assertions, unchanged.
  // aborted = count actual 'connection-destroyed' / '503' receipts.
  relay.recover();
  await retry.click();                     // Original real Retry, unchanged.
  // Original recovered content/identity/Cook assertions, unchanged.
  // recovered = count phase 'recovered', outcome 'forwarded', status 200.
  // Refresh both counters before their original assertions, including <= 3.
  // Persist relay.evidence(), source pins, exact URLs, screenshots and all results.
} finally { await relay.close(); }          // After stopping that owned frontend.
```

This is the concrete lifecycle/adapter proposal, not a substitute acceptance
callback or a newly admitted runner. The existing root selected-original scaffold
owns isolated frontend startup, two-width execution and evidence capture. The
frozen original callback and broad corpus helper remain byte-identical; root's
bounded selection can bind the selected genuine fields without demanding the
entire historical corpus loader. Review must explicitly accept the SSR read and
browser reload equivalence before applying these transport-only substitutions.

Selection/persona: visitor, original titles
`C31 / visitor / recipe network failure retries the same object and task` and
`C31 / visitor / recipe unavailable failure retries the same object and task`,
at the original 1440/390 widths. The same source object, structure, revision and
source receipts bind both cells. Existing original C17 state semantics and all
other C31 cells remain pending independently. No new runtime command is asserted
before the existing runner owner admits this adapter.

G-2757's precise dependency is confirmation that the immutable selected product's
existing initial read, local Recipe alert, disabled Cook and Retry still use
this SSR boundary. No new read control, product fault endpoint or source change
is requested. G-2774/root then review the transport substitutions above; the
current continuation does not apply them.

## Minimal retained fixture-coordinate request to G-2791

For the first unchanged report callback, titled
`C22 C26 / visitor / subject post and each reply have one owning overflow and no resting Report controls`,
the retained native Book already exists:

- Subject `https://rezics.com/id/01a15329-a5c8-760d-b1d5-22382dba559b`,
  `https://schema.org/Book`, H1 `Pride and Prejudice`.
- Main Version `https://rezics.com/id/01a15329-a5c8-760e-b396-c48d629a4e1f`.
- Existing isolated owner actor
  `https://rezics.com/id/5c4e27f1-4e3d-40da-89e6-e248d38fdf0a`.
- Its real `POST /v1/works` creation status is 201; saved receipt SHA-256
  `aeedff646787bf8a0784d1b0f8e184f2a6867e361ea875c9b135b0c9513d506c`.

Supply only the existing Book's canonical `/en` URL exposing the subject header
and discussion together, its exact public owned post ID/text and two distinct
owned reply IDs/texts placed under that post, plus normal command/ownership
receipt coordinates matching the existing isolated actor on Main 46775. Bind
these directly to `reporting.subject`, `reporting.post`, `reporting.reply` and
`reporting.secondReply`. If an existing record is absent, identify that record;
this request authorizes no seeding, importing or new fixture producer. The known
public Realm candidate is
`https://rezics.com/id/01a15329-8fb1-70b5-ab3e-a07479b4bc0d`; its placement must
come from the actual post read/receipt. Two replies counted in historical Main
3001 feed samples do not identify either reply or establish ownership on 46775.

That callback submits no report. Preserve the original report-POST denial,
afterEach denied-write/no-message checks, and `reportWrites === []`. No report
201, cover picker, login, full header matrix or Source footer is a prerequisite
to this one callback.

For the next existing keyboard/touch picker cases, separately request one
already-admitted genuine public selected cover UUID, its exact label/excerpt,
and retained native image/Media Use evidence from G-2780/G-2778 via G-2791.
The Book currently has a fallback cover, which cannot bind that selection. For
the later precise login-return callback, separately request the owned reply's
real Content revision, document Media Use locator UUID, exact
target/component/revision/locator and label/excerpt, plus the existing private
normal Accounts login binding. Credentials stay in approved private transport;
do not reuse shared audit credentials. The historical media-use 403 supplies
none of these successful bindings. Neither request requires seven submissions.
