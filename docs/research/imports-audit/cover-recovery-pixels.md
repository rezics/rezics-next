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
Assertions have not changed after native execution.

Focused command, through `bun scripts/worker-check.ts --`:

```sh
bun run --cwd services/kernel check test/imports/cover-recovery-pixels.test.ts
```

Check `45811b5f-4b8e-45e9-9192-66df37c4c652` exited **1**: **0 pass, 1 fail, 6 expect() calls**,
one test in one file, no skips/todos and no load reruns. Bun was `1.4.4-canary.1 (a0cc096ce)`.
First actual failure at line 154: `expect((await f.run(0)).status).toBe('committed')`, expected
`"committed"`, received `"bulk-failed"`. Scenario duration 60,727.51 ms; Bun duration 205.21 s.
No interrupted command/result/receipt was reached, so none is claimed or fabricated. This execution does **not**
prove the combined journey passes. The failure precedes editor selection, red disclosure and recovery; the
runner log does not expose a transport cause, so host load alone is not treated as proof of its cause.
The kernel compiler/format gates passed before scenario execution (669 Reylo analyses).
Log: `.temp/goal/checks/worker-check-2026-10-29T11-45-43.997Z-96101402.log`.

Earlier preparation: the initial check `0e60487c-d1bf-4df7-bc1c-2df1f227c33d` stopped producing output for
ten minutes; its one automatic rerun exited 1 at the new file's format gate, with zero scenarios executed.
Formatting was corrected and committed without changing assertions before the execution above. Its logs are
`.temp/goal/checks/worker-check-2026-10-29T11-14-50.417Z-b7045f11.log` and
`.temp/goal/checks/worker-check-2026-10-29T11-40-35.574Z-df5ff4aa.log`.

Root typecheck (`bun scripts/typecheck.ts`, through worker-check) initially exited 1 during tool preparation:
`LixError: Lix worker did not acknowledge request receipt within 30000ms`, followed by compiler database
`CONNECT_TIMEOUT` errors. First retry exited 1 at web route generation with `LixError: Lix worker is closed`;
its kernel and Auth compiler checks passed. The second and final infrastructure retry also exited **1**:
`LixError: Lix open did not settle within 30000ms`, then compiler database `CONNECT_TIMEOUT` at
`127.0.0.1:45604/rezics`. Remote cleanup also reported `could not remove` its isolated run directory.
Check `ca9e4add-00f8-439d-b260-98fa6f65dcc0` is finished, log
`.temp/goal/checks/worker-check-2026-10-29T11-55-25.618Z-8cf5982e.log`. Both allowed manual
infrastructure retries are exhausted; no root typecheck success is claimed. This required tool boundary is blocked.
Logs: `.temp/goal/checks/worker-check-2026-10-29T11-14-59.264Z-69f54f98.log` and
`.temp/goal/checks/worker-check-2026-10-29T11-35-18.673Z-c5760053.log`.

The nonempty artifact command is delivery only; it must not be interpreted as native acceptance passing.
No old recovery cases, whole media suite, full kernel/web check or root gate were run.
