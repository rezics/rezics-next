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
