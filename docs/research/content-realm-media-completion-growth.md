# Realm media completion operation binding

Authority: [Content Done when and Acceptance](../goals/content.md),
[Realm asset completion Cost](../../services/kernel/src/content/README.md#cost-realm-asset-completion),
and [physical verification](../development/verification.md#check-selection-and-failures).
This document binds the private native growth acceptance; it does not replace those contracts.

The retained base is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`, initially clean and matching the controller's source.
On that base, `media-realm-assets.test.ts` already refuses completion after management revocation;
`growth-media.test.ts` measures direct media commands with admitted Access;
`growth-media-realm-download.test.ts` measures download with combined unrelated history.
None supplies separate native Realm completion/replay measurements on independent population and history axes.
This is missing acceptance, not an observed product failure.

Decision: each phase grows a fresh 256/1024/4096 cohort, retaining earlier cohorts as fixed background because Realm revisions are append-only.
The observer reports actual relation sizes as well as cohort scales; scales are added pressure, not total table cardinality.
The two axes execute separately. Population growth leaves Realm/grant/receipt pressure fixed; history growth leaves
reservation/media pressure fixed. Completed cohorts and native setup remain present throughout the following series.

## Selected operation

- Setup: the read-only native Realm/download fixture provisions Auth clients and accounts through native Auth,
  uses `testKernel`'s production Access factory, and creates the Realm through HTTP. A private grantor bootstrap
  permits a native grant of `media:complete` to the wrong uploader, independently of identity refusal.
  Every selected icon/banner reservation uses `POST /v1/realms/{realmId}/media` as its actual uploader.
  One real 96×48 PNG buffer is encoded once and written through the isolated S3-compatible fixture store;
  every reservation and completion uses its measured length and SHA-256. Fixture storage keys/digests are checked.
- Admission: the real website credential reaches `POST /v1/media/{id}:complete`. Exact permission SQL and bound
  resource IDs show current `media:complete` and `realm:manage` before receipt lookup. No permissive Access stub,
  hand-written selected media row, fabricated receipt or direct image effect supplies success.
- Initial completion: a fixed pool of 18 native reservations covers warmups, one measured repetition per scale
  and the shared harness's four cold-backend discards. Icon and banner selections alternate. Each sample consumes
  one fresh reservation; byte inputs, parent Realm, uploader, local row shape and storage size remain fixed.
  The state becomes `uploaded`, with exact container/purpose/reservation/uploader, declared and measured
  bytes/digest, one completion receipt and one linked uploaded event. No derivatives or permanent claim exist.
- Replay: a different precompleted reservation reuses the exact completion key and body. Both current permissions
  precede receipt lookup; no completion update runs. Response, receipt identity/digest/position/transaction,
  media state and event count remain identical. Native reservation and byte storage are outside this observation.
- Refused requests: valid input mismatching uploader, reservation, same-route container, measured bytes or digest
  retains HTTP 403. Bob has both native permissions, so his uploader refusal is independent. Oversized measured
  bytes and malformed digests retain HTTP 400; no database minimum is assumed for schema rejection. Each refusal
  asserts no completion update or receipt lookup and preserves the pending reservation without a receipt/event.
  The physical refusal series includes all seven requests, rather than dropping refused work from the bound.
- Revoked management: native revocation precedes a separate series. A reserved upload, exact successful replay
  key and new completion key on an uploaded reservation all return 403. Both permission probes execute before
  the refusal; no receipt is read, no update runs, and successful historical receipt/event state stays unchanged.
- Terminal publication: after restoring management, a separate series relays a fresh native uploaded event through
  registered `registerContent` effects and the production Sharp workflow. The fixed setup prefix is drained first;
  each selected reservation/completion is prepared outside publication observation. Both deterministic workflow
  handles must finish successfully; storage objects, media availability and 1–12 derivatives are checked.
  SQL issued by the registered runner belongs to this physical capture. Completion alone never proves availability.

## Cost and measurement

### Realm asset completion and replay

- Touches: native HTTP authentication/admission, exact reservation and uploader, media permission, current Realm
  head/management, receipt lookup, and (initial completion only) one media update, receipt and uploaded event.
- Bound: constant examined rows/statements and O(log R) buffers, with the existing 20 MiB measured-byte ceiling.
  HTTP/database request and response bytes remain constant. Rejected commands remain included.
- Growth check: `test/content/growth-realm-media-completion.test.ts`, separate initial, replay, input-refusal and
  revoked-management series on each axis at 256, 1024 and 4096 added records. All pressure uses the selected route
  and one fixed partition. Unrelated history consists of an unselected Realm's immutable revisions, expired
  management grant intervals and completion receipts. Its head does not move; selected bytes/head/grants stay fixed
  within each series. No page-limit, planner, runtime budget or TTL change is introduced.

### Registered image publication

- Touches: native uploaded event, registered effect relay, effect/Sharp workflow persistence, source bytes,
  media transition and derivative rows/objects. Registered runner SQL is included rather than inferred from enqueue.
- Bound: constant indexed SQL, O(log R) buffers, at most 20 MiB original bytes, 40 million decoded pixels and twelve
  variants, as in the existing publication Cost. Completed workflow counts and actual stored byte/variant counts
  are observed with fixed input and per-repetition ceilings.
- Growth check: a separately named publication series on the same independent axes and scales. It proves publication
  only after awaiting both registered workflow results. Auth's fixture-owned in-process executor is deregistered
  after native account setup; Content's registered executor is then started and shut down by this test.

The shared `checkGrowth` observer/classifier supplies actual statement attribution, examined rows, native plans,
shared hits/reads/buffers, relation sizes, background work, limitations and three-scale verdicts.
`assertGrowthAccessPaths` checks measured growing relations. `REALM_COMPLETION_GROWTH` stdout includes the exact
source `git rev-parse HEAD`, image size/digest and the complete report, including actual statements and repetitions.
No report is committed as an audit artifact. A reached functional assertion or physical bound failure remains a
failure; production implementation, limits and shared fixtures cannot be changed to obtain green.

## Execution boundary

Focused landing command, from the worktree root:

```sh
bun run --cwd services/kernel typecheck
bun run --cwd services/kernel check test/content/growth-realm-media-completion.test.ts
```

The controller owns frozen acceptance after integration. Authoring, typechecking, queuing and infrastructure exits
do not supply three-scale observations or a promotion claim. The runtime report is the source for reached assertions
and observations; until the focused runner reaches them, their status is deferred, never passed. No root, browser,
worker-check, remote-check or additional native suite is requested by this slice.

The typecheck launch on `2bcffe8a20` exited before compilation: `error: script "typecheck" exited with code 70`.
The shared runner classified run `mvzyt1ve-a647f983` as `infrastructure-failure`, with
`absolute preparation deadline exceeded` in `source-artifact-publication` on host `b`.
This reaches no compiler assertion and supplies no growth observations. The focused landing launch uses the
following committed document revision; any reached three-scale observations are emitted with its full source hash.

Read for binding: the Content Goal and Realm media/Cost sections; agent conduct and workflow verification;
the existing functional Realm assets and media/download growth tests; the shared native Realm/download and
native collection fixtures; media completion, its HTTP/schema/SQL and image/work registration seams;
the shared growth capture/report/counter/access-path interfaces and SQL observer; and the relevant Realm revision,
media and grant constraints. No external reference source is named by this contract.
