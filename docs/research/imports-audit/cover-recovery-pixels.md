# Composed native cover recovery pixel witness

The new case in `services/kernel/test/imports/cover-recovery-pixels.test.ts` combines actual imported red cover
selection, interrupted green replacement, same-SQLite recovery, and subsequent blue replacement. Native execution
and the exact frozen test digest/revision are recorded below; this file's nonempty check is delivery evidence only.

The factory registers defaults before returning. The case overrides those exact three allowed URLs through
`runtime.mediaBoundary.source(url, undefined, bytes)` before any import. The inputs are small Sharp-encoded
24 × 16 RGB PNGs. Production conversion, media reservations, native jobs, fetch policy/caps, Sharp, storage,
credentials, Access, editor acceptance/adoption, command receipts and revisions remain actual. No helper,
product, existing test, schema, metadata ABI or source policy changes are needed.

The existing one-shot interceptor proves persisted local ACK immediately before deferred completion, then
aborts. The new case additionally reads that exact journal key before and after reopening the same SQLite file,
compares bound command bytes, candidate/key/media, actual result and native receipt, and checks no duplicate
or retraction of the recovered candidate. The legitimate red retraction remains required. Green is explicitly
selected before public assertions; no public-cover change is inferred from an unselected candidate.

Anonymous subject and mounted native page reads must disclose the selected actual media, source references,
rights holder via Bangumi, and `LicenseRef-unknown`. Every variant returned on both surfaces requires an actual
download authorization, exact storage key, storage bytes matching native observation/hash, and Sharp decoding
with the intended dominant channel above 200 and other channels below 40. Original bytes/hash are independently
checked against the encoded input. Original public downloads require 404. Green/blue derivatives must differ
from earlier hashes. No hotlink/redirect, upstream authorization/cookie/private metadata, or live Internet
request is permitted. Same-input repeat and reopen preserve commands, receipts, media observations and job capture.

## Sources, decisions and limits

Read the old three-case native test, its recovery factory and report, deferred recovery report, native media
boundary/observer and boundary spec/driver, importer recovery contract and binding types, subject summary types,
Imports Goal, architecture/scope and development verification rules. No reference source is named for this surface;
no external reference implementation was required or copied. Also read `media-distinct-input.test.ts`: its
separate normal red/blue import and source-ownership checks do not prove the interrupted combined journey.

Decisions: use the factory unchanged (including its tmpfs journal and 600-second timeout), use bounded exact-key
journal reads for durable ACK evidence, and decode every served variant rather than infer pixels from source URLs.
Only one subject/source/run, three source URLs/media IDs, exact receipt keys and candidate pages capped at 100
are observed. This is a native producer/recovery/pixel witness, not growth, general sourceRecords attribution,
Collections/Everything/state, Zone, TypeList or web-rendering evidence. No files outside the two declared paths changed.

## Execution

Frozen title: `actual interrupted cover replacement recovers exact acknowledged media and serves distinct recovered and subsequent replacement pixels`.
Test revision: `cc227ce896776a230ba993707a9c422718ee64fb`.
Test SHA-256: `751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`.
Assertions remain unchanged from the earlier focused execution and are frozen.
Retry execution revision: `3869963f11449c86731f48044d16e05418567561`.

Focused command, through `bun scripts/worker-check.ts --`:

```sh
bun run --cwd services/kernel check test/imports/cover-recovery-pixels.test.ts
```

Check `20710f01-82a9-4da9-ba81-ccd9910e3954` exited **0**: **1 pass, 0 fail, 595 expect() calls**,
one test in one file, no skips/todos and no load reruns. Bun was `1.4.4-canary.1 (a0cc096ce)`;
test duration was 29.35 s. The kernel compiler/format gates passed (669 Reylo analyses).
The check waited 242.825 s for a slot, then ran its command in 93.823 s. No test or product fix was needed.
Log: `.temp/goal/checks/worker-check-2026-10-29T14-09-17.611Z-8607eb08.log`.

The actual interrupted native command and result were:

```json
{"command":{"op":"propose","key":"bangumi:424242:1c4e280df87f6586c8695f22d18de952165024ef48ae5a5975ebef73aa34f5ea","source":{"source":"bangumi","external_id":"424242","record_revision":"unversioned","converter_revision":"bangumi@3","digest":"cff54636a2b8bca8cff5d1457b80ea57364fbba190a670aa1d0971fe91b67f9b","field_group":"cover"},"subject":"01a18803-b3fc-75a1-a706-b3f99b78d2a6","statement":{"property":{"id":"schema:image"},"value":{"type":"value","content":"01a18803-b8ab-739f-97cc-b3f9e6eb0215"},"references":[{"parts":[{"property":{"id":"schema:url"},"value":{"type":"value","content":"https://bgm.tv/subject/424242"}},{"property":{"id":"schema:url"},"value":{"type":"value","content":"https://lain.bgm.tv/pic/cover/l/ab/cd/replacement.jpg"}}]}]}},"result":{"key":"bangumi:424242:1c4e280df87f6586c8695f22d18de952165024ef48ae5a5975ebef73aa34f5ea","status":201,"value":{"candidate":"6366b3c8-43ad-87f8-9c32-b3f957e53559","revision":22}}}
```

The exact persisted native receipt, unchanged across recovery and replay:

```json
{"partition_no":2879,"principal_kind":"account","principal_id":"764ada75-62ac-8c41-a37c-aefc8c0cfe2a","command_kind":"subject.batch_propose","idempotency_key":"bangumi:424242:1c4e280df87f6586c8695f22d18de952165024ef48ae5a5975ebef73aa34f5ea"}
```

The recovered local binding retained that command key, candidate, subject and exact serialized command bytes.
Its binding signature was `2c20b2e994e6f6945e08cb8b74f8e95ca82a713646b501a8f35d701f03ae2188`.
All three originals matched their acknowledged native SHA-256 and available media identity:

| Input | Native media | Original SHA-256 |
| --- | --- | --- |
| Red | `01a18803-b445-70e1-8c67-b3f920058e00` | `73b890ef39bd02ae80be6353cddd8b286d754874289b20050d2491c4f271ab99` |
| Recovered green | `01a18803-b8ab-739f-97cc-b3f9e6eb0215` | `68fa4b251cdcb8b79083c873db5090a2351d508c3f35bc6d83417d24963b5dcc` |
| Subsequent blue | `01a18803-bc1a-77e5-b4e6-b3f9530effd5` | `384ac8c8ffc149c4bbbb7d4ac2f60d627c75576810ab81310f314cfb56c30a12` |

Every authorized derivative was decoded on both anonymous subject and native-page surfaces.
The distinct derivative SHA-256 values (each repeated across those two surfaces) were:

- Red: `080442758717f880e59084359282946b1837cfe4df8fa68fadc21aed0e93c000`, `65914f854702ba7cd91f364c6af7e929529f187ee5028d1a41aed86198dbebf3`.
- Recovered green: `ef11a9f189a973579df5ea38f194cd6112f8929a45ff1c2ac3b0642c9a874320`, `cb48de90f969c72a630129e997068ce1d4eb1e81056094a26440c2d8bef836aa`.
- Subsequent blue: `07ac349c19b489252a37de49c95a4768268395d69c4d7365f151a3a24d07aff3`, `1b8fbd8596e577a836cc006cf812613d7ede148e30aa450d45c25db4dca23cdb`.

The green recovered candidate was explicitly selected before green disclosure; blue was selected after normal
replacement. Exact native receipt, durable local ACK, command bytes, candidate/media identity and job capture
survived same-SQLite recovery and identical-input repeat/reopen. Earlier-cover retractions remained required.
The combined interruption/recovery/pixel witness passes on the retry's unchanged starting revision.

Required root typecheck, `bun scripts/typecheck.ts` through worker-check, also exited **0**.
Check `bc8a3291-4c57-4d59-888d-85d3ced22a20` completed all 13 workspace typechecks, including kernel,
Auth and web. The command ran in 66.795 s after waiting for a shared slot; no infrastructure retry was needed.
Log: `.temp/goal/checks/worker-check-2026-10-29T14-11-21.587Z-31191afc.log`.
The earlier Lix/compiler connectivity failure did not recur in this retry.

Delivery command, through worker-check: `test -s docs/research/imports-audit/cover-recovery-pixels.md`.

### Earlier attempt

The earlier focused execution `45811b5f-4b8e-45e9-9192-66df37c4c652` exited 1 with **0 pass, 1 fail,
6 expect() calls**: version-0 import returned `bulk-failed` instead of `committed` at line 154.
No interrupted ACK was reached. Its log is
`.temp/goal/checks/worker-check-2026-10-29T11-45-43.997Z-96101402.log`.
An earlier preparation run hit a format failure after an automatic infrastructure rerun; formatting was corrected
before that execution without changing assertions. Earlier root typecheck attempts encountered Lix worker/open
30-second timeouts and compiler database `CONNECT_TIMEOUT`; the earlier attempt exhausted its two manual retries.
Those historical failures do not establish a current blocker; the native retry above passes unchanged.

The nonempty artifact command is delivery only. No old recovery cases, whole media suite, full kernel/web check
or root gate were run.

### Current contract revalidation

Preflight at base revision `c02c32e34c3dd1d824909ce938c812abf863664a` found the complete composed case
and its passing evidence already present. Its frozen SHA-256 remains
`751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`; no assertion or helper edit is warranted.
The actual factory still exports runtime, the three default URLs, importer, covers/listing/select, interrupted
command/result/receipt, reopen/run and close. Defaults precede return; the actual boundary accepts
`source(url, fault?, encodedBytes?)`, copies bounded owned input and replaces the exact URL registration.
The interruption still occurs after durable local ACK and before deferred completion; reopen retains the same
SQLite path. The current case already selects each actual candidate and decodes authorized storage bytes
across the red, recovered green and subsequent blue journey.

Decision: preserve the already frozen case and revalidate it once, together with the affected kernel typecheck
and the nonempty artifact delivery command. Only this report changes; no outside-path files change.
Historical evidence above remains attributed to its original execution and is not presented as a new run.

Current execution revision: `ee335bd9fe`. All three prescribed launches returned exit 1 immediately with
`Invalid check id: --`, before creating a check ID or executing any compiler, test or artifact command:

```sh
bun scripts/worker-check.ts --run -- bun run --cwd services/kernel check test/imports/cover-recovery-pixels.test.ts
bun scripts/worker-check.ts --run -- bun run --cwd services/kernel typecheck
bun scripts/worker-check.ts --run -- test -s docs/research/imports-audit/cover-recovery-pixels.md
```

This is one initial tooling attempt and two further attempts of the mandated launch syntax; no further retry
was made. Inspection of the actual CLI shows `--run` consumes its next argument as an existing check ID;
command submission instead uses its default branch. Therefore the contract's required `--run -- <command...>`
syntax cannot submit a check on this base. No checks were queued, no tests were rerun, and no new native
command/result/receipt or assertion count was produced. The frozen test hash remains unchanged. Changing the
runner or silently substituting another launch protocol is outside this witness-only contract. The tool failure
blocks current revalidation; the historical passing combined witness remains preserved.

### Latest retry preflight

Starting revision `97a6db186d002b0bbbae168149c8d01a1f6f58cb` is clean on the assigned worker branch.
The composed test and recovery factory were read again; the frozen test SHA-256 above is unchanged.
The required delivery launch was retried before treating the manifest's failure as current:

```sh
bun scripts/worker-check.ts --run -- test -s docs/research/imports-audit/cover-recovery-pixels.md
```

It again exited 1 with `Invalid check id: --` and created no check ID. The checked-in runner still routes
`--run` to an existing record, rather than command submission. At revision `b0a4c05705`, two further prescribed
launches (the focused native test and affected kernel typecheck, as listed above) each exited 1 with the same
exact error. This exhausts the initial attempt and two retries. No check IDs were created and no test,
typecheck or artifact command executed. No frozen assertion, helper, product or runner change is made.
The current attempt is blocked by check submission tooling; historical passing evidence is unchanged.

### Retry from the supplied manifest

At committed revision `71818df6ab2a1525a91c743c19cf88c50112bf9f`, the mandated artifact launch was
retried before relying on the earlier failure. It exited 1 with `Invalid check id: --`; no check ID was
created. Current `scripts/worker-check.ts` still dispatches `--run` to `runRecordedCheck(args[1])`,
so the required separator is parsed as a record ID. The frozen native test remains untouched.

At revision `c0f8d6d15d`, the focused native-file launch and affected kernel typecheck launch listed above
were each retried using the mandated `--run --` protocol. Both exited 1 with the same exact error before
execution or check-ID creation. The initial attempt and two retries are exhausted for this attempt.
No assertion, helper, product, runner or outside-path file changed. No new native results are claimed;
the historical 595-assertion pass remains separately attributed above. Current validation is blocked by
the check submission tool, including the artifact command itself.

### Revalidation after the supplied retry manifest

The retry started clean on the assigned worker branch; pre-edit HEAD was
`464bdea98344af60b797e1907043da7a9212eea8` (the manifest names the earlier `0fb1a295` revision).
The composed case, old recovery test, recovery factory, distinct-input test and current boundary API were
read again. Preserve the frozen case: its source overrides and real ACK/reopen/selection journey still match
the contract; no helper or product change is justified. No outside-path file changes are needed.

The required artifact launch was retried before relying on the manifest's failure:

```sh
bun scripts/worker-check.ts --run -- test -s docs/research/imports-audit/cover-recovery-pixels.md
```

It exited 1 with `Invalid check id: --` before creating a check ID or running the command.
The current CLI still interprets the separator as an existing record ID in its `--run` branch.
This is a fresh submission-tool failure; historical native evidence above is not a current execution.

At committed revision `e4b505d879`, the mandated focused native-file and affected kernel typecheck
launches were the two retries. Both exited 1 with the identical `Invalid check id: --` error before
creating any check ID. The initial attempt and two retries are exhausted. No check was queued or
executed, and no new assertion count, native command or receipt is claimed. The test's frozen SHA-256
remains `751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`.
Only this report changed; the witness-only contract's prohibition on helper/product edits is preserved.
Current acceptance validation remains blocked by the required check submission tool.

### Current submission protocol retry

Starting revision: `7bacbb97182a7297b41479456191aff317ebd18d`. The current contract explicitly
requires `bun scripts/worker-check.ts -- <command...>`. Earlier `--run --` failures above
belong to previous attempts; the current default submission branch accepts the required syntax.
The existing composed test, old recovery cases/report, recovery factory, distinct-input case and
current MediaBoundary source API were inspected again. Preserve the frozen test and its SHA-256
`751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`; it already covers
the composed journey. No product, helper, old test or outside-path edit is needed.

Decision: submit the delivery command first to retry the manifest failure, then exactly one
focused native-file check and the affected kernel typecheck. No whole-workspace gate is required.
Results from this submission will be recorded separately from historical execution evidence.

At committed revision `192e368d00`, all three submissions returned check IDs successfully:

- Delivery: `285cea80-8323-4d51-8802-f245992e1398`.
- Focused native file: `52ae48d7-4316-48a6-b865-32dce3962944`.
- Affected kernel typecheck: `8a7ea23f-eb64-43b1-8d02-e8475d07a963`.

These are queued/running submissions, not passing results. The manifest's submission failure
did not recur with the current required syntax. Assertions remain frozen and unchanged.

### Fresh validation on the assigned worker branch

Starting revision: `6f7982dbe20087446fd761d729fbcfb41f2c8232`.
The requested composed case already exists in this base. Read its complete assertions, the actual
`openCoverRecovery` factory, the old native recovery cases and reports, the distinct-input witness,
and the current `MediaBoundary.source(url, fault?, encodedBytes)` implementation before deciding
that no additional case or assertion edit is needed. Its frozen SHA-256 remains
`751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`.
The factory still registers defaults before returning and exposes the real ACK, same-file reopen,
editor selection and bounded native job delivery required by this contract.

Decision: preserve this existing frozen witness and revalidate it once, with the affected kernel
typecheck and the delivery-only nonempty report command, using the current separator submission
protocol. Prior queued IDs and historical results above are not results for this fresh validation.
Only this report changes; no outside-path file, helper, product, dependency or frozen assertion changes.

Submitted at revision `e489580f74` through `bun scripts/worker-check.ts --`:

- `bun run --cwd services/kernel check test/imports/cover-recovery-pixels.test.ts`:
  `8e83022f-605f-41d6-887f-fdd5810b265e`.
- `bun run --cwd services/kernel typecheck`: `cccabd58-e247-4669-9db5-9836fcc69160`.
- `test -s docs/research/imports-audit/cover-recovery-pixels.md`:
  `3ae27b4b-9448-41cd-beaa-21f75a043477`.

Submission succeeded; execution results are pending manager delivery. No polling or old-case rerun
was performed. The native command/receipt and counts above remain historical until fresh results arrive.


### Fresh validation results

All three submitted checks exited **0**, as delivered by the manager and confirmed in their logs.
Execution revision: `e489580f74` (subsequent edits only record evidence in this report).
The focused native file ran exactly once: **1 pass, 0 fail, 595 expect() calls**, one test in one
file, 46.56 s, zero load reruns. Its title remains
`actual interrupted cover replacement recovers exact acknowledged media and serves distinct recovered and subsequent replacement pixels`.
The frozen test SHA-256 remains
`751500e9c56f1b840f5f149d56b511537638867388976bcb245f55bedd72d171`.
No assertion changes or product fixes were needed: the composed case already passes in the supplied base.

The native-file compiler/format gates passed, with 675 Reylo analyses. The affected kernel typecheck
also passed, including `tsc --noEmit --runExternalCode -p tsconfig.json` and native construction.
The delivery command `test -s docs/research/imports-audit/cover-recovery-pixels.md` passed.

Logs, corresponding to the submitted IDs immediately above:

- Native file: `.temp/goal/checks/worker-check-2026-10-29T18-35-46.127Z-bf86ffc5.log`.
- Kernel typecheck: `.temp/goal/checks/worker-check-2026-10-29T18-35-46.309Z-ee2b99a7.log`.
- Delivery: `.temp/goal/checks/worker-check-2026-10-29T18-35-46.521Z-04f042bc.log`.

Fresh actual interrupted command/result:

```json
{"command":{"op":"propose","key":"bangumi:424242:29688a45fadae520afe24bd3b4bd02e91443582caa1ce31947c0831f52b7029e","source":{"source":"bangumi","external_id":"424242","record_revision":"unversioned","converter_revision":"bangumi@3","digest":"cff54636a2b8bca8cff5d1457b80ea57364fbba190a670aa1d0971fe91b67f9b","field_group":"cover"},"subject":"01a18901-3b35-740f-a721-7b4081e40d74","statement":{"property":{"id":"schema:image"},"value":{"type":"value","content":"01a18901-4088-7091-86ca-7b401d0a42ed"},"references":[{"parts":[{"property":{"id":"schema:url"},"value":{"type":"value","content":"https://bgm.tv/subject/424242"}},{"property":{"id":"schema:url"},"value":{"type":"value","content":"https://lain.bgm.tv/pic/cover/l/ab/cd/replacement.jpg"}}]}]}},"result":{"key":"bangumi:424242:29688a45fadae520afe24bd3b4bd02e91443582caa1ce31947c0831f52b7029e","status":201,"value":{"candidate":"04b8b8da-cb20-8617-88a6-7b40e2730042","revision":22}}}
```

Exact actual native receipt retained across recovery/replay:

```json
{"partition_no":1972,"principal_kind":"account","principal_id":"764ada75-62ac-8c41-a37c-4d9a8c0cfe2a","command_kind":"subject.batch_propose","idempotency_key":"bangumi:424242:29688a45fadae520afe24bd3b4bd02e91443582caa1ce31947c0831f52b7029e"}
```

Recovered binding signature: `03ff5ce07537542147b8b43a9d4dda4d9e74a8fa9444c5b678a367b1076da419`.

| Input | Actual native media | Original SHA-256 |
| --- | --- | --- |
| Red | `01a18901-3b7f-733b-9a2d-7b408096f006` | `73b890ef39bd02ae80be6353cddd8b286d754874289b20050d2491c4f271ab99` |
| Recovered green | `01a18901-4088-7091-86ca-7b401d0a42ed` | `68fa4b251cdcb8b79083c873db5090a2351d508c3f35bc6d83417d24963b5dcc` |
| Subsequent blue | `01a18901-4481-70e5-b07f-7b40afa28893` | `384ac8c8ffc149c4bbbb7d4ac2f60d627c75576810ab81310f314cfb56c30a12` |

The fresh derivative hash sets match the three distinct sets recorded above; all derivatives were
authorized, read from actual storage and Sharp-decoded on both anonymous subject and native-page reads.
The recovered ACK/candidate/key/bytes/receipt survived same-SQLite reopen, with the required earlier
cover retraction. Explicit editor selection preceded green and blue disclosure. Identical-input
repeat/reopen preserved receipts, effects and job capture. This establishes the composed witness only;
it does not establish the separate consumer/scalability obligations listed above.

No files outside the declared paths changed. The frozen test, helper, source policy, metadata ABI,
schema and production code remain unchanged. No old recovery suite or whole-workspace gate ran.
