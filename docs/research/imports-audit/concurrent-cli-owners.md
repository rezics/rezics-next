# Concurrent ordinary CLI source ownership

The frozen native case is `Concurrent ordinary CLI source ownership and isolation` in
`services/kernel/test/imports/concurrent-cli-owners.test.ts`. Its caller uses one `openApiRuntime`,
existing `identitySupport` and `openApiObserver` exports, and the runtime's registered media worker.
Operator credentials go through actual Auth stage/approve/apply effects. All invocations use the ordinary
account-key CLI arguments, one private SQLite file on tmpfs and real Auth/public HTTP replies.

The caller establishes A's work and edition, holds A's next real stdin iterator before EOF, invokes a
same-alias competitor and completes B in that same file while A remains held. B initially imports only an
edition, proving it cannot borrow A's work claim; subsequent complete input learns B's own work. Signal
cancellation returns the held iterator and closes A, and a new CLI invocation completes its revised input.
Exact-key observations retain both sources' claim identities, reference targets, immutable prior journal
bytes and native receipts. A complete native/local snapshot of B is compared across A's recovery.
Independent public acceptance/adoption then selects both titles before an exact A/work/facts takedown.
Public subject reads supply the resulting visible values; tuple fence checks independently distinguish B.

Decisions: cancellation recovery is the required ordinary operator journey. A process-death leg is unnecessary
for it; this caller makes no new process-birth recovery claim. Bibliographic inputs retain native work revision 7
and edition revision 11, with A's controlled refresh at revision 8. Covers and unknown-licensed prose are omitted
from the supplied input. Converter revision is read from the actual Open Library export (`open-library@3`).
The local connected acquisition proof reached an existing cancellation defect: the staging catch classified an
AbortSignal read interruption as invalid input (CLI code 2). It now recognizes the actual aborted signal as
interrupted (CLI code 130), preserving invalid-input classification for non-cancellation failures.

The raw native log emits `concurrent CLI native evidence`, including each invocation's actual result,
input SHA-256, consumed bytes, EOF/return observations, Auth paths, exact public request/response bytes,
source rows, journals, native receipts, independently read subjects/candidates/revisions, fence responses,
and definition-bundle digest. Authorization headers, bearer values and private JWKs are never logged.
Receipt SQL is anchored by partition, principal, command kind and exact captured idempotency key;
external claims use the exact tuple route/source/native key. SQLite observations address the two supplied
record keys only. The final handle proof checks every observed CLI database is closed, each returned handle
counter, and the actual remaining owner count after all invocations.

The local importer test is a separate pre-effect proof: two ordinary CLI acquisitions, same-alias refusal,
independent ownership, cancellation and reopening with zero HTTP calls. It cannot prove native publication.
The first managed native run tested revision `fc70ca1fd2d59ccff1cbe6e254be48654017fd41` and reached
the final tuple fence reads after 789 assertions. Its governance observer correctly received HTTP 403:
that observer has takedown authority, while ordinary CLI credentials hold `source_fence:read`. The caller
now reuses each source's captured CLI Authorization header for those independent native reads, keeping
headers out of diagnostics. The first failure is recorded in
`.temp/goal/checks/worker-check-2026-10-30T05-45-16.655Z-e3a661a0.log` (one case, zero passes, one failure).
The repaired managed run passed on code revision `6e92b5a01e9ed406c089e8dbb2e0fbb067636bc5`:
one case, `Concurrent ordinary CLI source ownership and isolation`, 820 assertions, zero failures, exit 0.
The raw log is `.temp/goal/checks/worker-check-2026-10-30T07-49-48.840Z-2efc00bb.log`;
its `concurrent CLI native evidence` JSON contains the observations below. There were eight ordinary CLI
invocations in one process and one native application world; no process-death child was required.

| Invocation | Source | Actual result |
| --- | --- | --- |
| Initial work | A | code 0, one new record |
| Initial work and edition | A | code 0, one new and one unchanged record |
| Held acquisition | A | code 130 after signal, no EOF, no Auth or public requests |
| Same-source competitor | A | code 5, zero consumed bytes, no Auth or public requests |
| Independent edition | B | code 0, one new record while A remained held |
| Complete work and edition | B | code 0, one new and one unchanged record |
| Refresh late reference | B | code 0, two unchanged records |
| Reopened owner | A | code 0, one changed and one unchanged record |

`oldAReceipts` retains nine receipts, all present unchanged in the thirteen `currentReceipts`.
The first work creation receipt has transaction `01a18be2-89a8-7792-a694-e9e497bdb77d`,
command key `concurrent-books-a:/works/OL900000001W:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`
and subject `01a18be2-89ae-77bb-b808-8d4ca50dd30c`. B's independent work is
`01a18be2-8f71-7223-88fa-bacdb86e28ab`. `sourceBBefore` and `sourceBAfter` are identical,
including two record entries, eleven receipts and two independently read native subjects.
The final `publicReads` show A's fence security revision 1, B unfenced, A's selected name absent and B's
selected name retained. The frozen test also confirms no foreign receipt disclosures and zero open handles.

The recorded converter is `open-library@3`; catalogue version is `1.0.0`, with bundle digest
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.
Pinned fixture SHA-256 values are work `fa8164feb83ccdd8d608fa976dd07edda1366155cc893753ef04df0f8ad9f8cd`
and edition `84040aeecceade5418195ba9361d99ba236ee0c9c672bd381bac24d57ce2bdb3`.
Actual record digests in `oldA.entries` are work revision 7
`8ae945d072b4eedbc65d006f79e3d9d7337d698c89e77d3009a11210061c98b1` and edition revision 11
`9f803fab7d40aafe49794a962a7a7f7ba387ea93a84204744cfdfa1c2e01b427`.
Recovered work revision 8 has digest `bfeae026e4f6a0b56737e57c973d725260eaf0551bbd1fc139984bcb3893415d`.

Edited-file formatting, the directly affected importer compiler and the focused local test (one case,
22 assertions) passed. Independent source review found no remaining authority or disclosure regression.
No files outside the declared paths changed, and the frozen acceptance is unchanged. Root typecheck,
affected checks and sibling regressions remain owned by the landing batch. The previous missing-caller red
was a binding gap, not evidence of a production ownership defect.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/concurrent-cli-owners.test.ts
```

## Operate concurrent source aliases

- Touches: supplied bytes and exact-source record/reference/journal anchors, native Auth/public requests and bounded native receipts and subjects.
- Bound: existing importer, transport and native API bounds; O(supplied bytes + (S+D)(1+q) log R), with existing bounded q and retained page size. No source/catalogue/history scan or growth harness.
- Growth check: native PG growth evidence is missing for this new caller; existing bounds and canonical PG/derived units are unchanged.

Source references inspected: existing CLI, Importer, ImportSession, RunStore and RecordBindings; the
Open Library converter and pinned work/edition JSON; existing named-feed/disappearance native callers;
identity fixture, API runtime/observer and their registered media boundary. No external reference code is ported.
