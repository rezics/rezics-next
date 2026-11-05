# Known reference matcher compiler evidence

The approved helper reproduces the reported excess-property error with the installed compiler. The proposed
change factors only the expected property expression into a local variable before Bun contextualizes the matcher
argument. The final affected kernel compiler run passes with this factoring. This is a bounded compiler witness and a proposed frozen-file
amendment, not native acceptance, admission, or a runtime outcome claim.

## Installed types and decision

- TypeScript: `7.1.0-beta` (installed executable reports `Version 7.1.0-beta`).
- Installed Bun: npm distribution `1.4.4-canary.20261027.1`; version output `1.4.4`; revision
  `1.4.4-canary.1+a0cc096ce`; full revision `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`.
- `@types/bun`: `1.4.4`; its installed dependency `bun-types`: `1.4.4`.
- The shell bootstrap Bun reports `1.4.3`; the check runner installs and invokes the pinned distribution on its host.
- The TypeScript-version-specific Bun entry point references the same actual `test.d.ts` declarations.

The installed `test.d.ts` declares these overloads:

```ts
toContainEqual(expected: T extends Iterable<infer U> ? U : T): void;
toContainEqual<X = T>(expected: NoInfer<X extends Iterable<infer U> ? U : X>): void;
```

Native `Statement.qualifiers` is `Snak[]`, with a required `property.data_type: DataType`. Proposal
`BatchStatement.qualifiers` is optional and its snaks have id-only properties. The explicit union matcher generic
alone does not prevent the actual compiler from applying the id-only property contextual type to the fresh nested
literal. This is observed compiler evidence, not a replacement declaration or mocked matcher.

The narrow factoring decision is to infer the property conditional before placing its result in the matcher
argument. The helper retains its actual imported parameter types and the approved explicit matcher generic.
Structural assignability admits the inferred local property; the fresh nested literal no longer receives the
id-only excess-property check. No cast, suppression, asymmetric matcher, dependency change or API change is used.
The full expected object remains a fresh matcher argument, so the value discriminant still receives the existing
matcher contextual type. There is no broadening of the asserted runtime condition.

Each invocation still first asserts `somevalue`, then makes exactly one `toContainEqual` deep-equality comparison.
Native expected property remains exactly `{ id: 'wdt:P648', data_type: 'external-id' }` and proposal expected
property remains exactly `{ id: 'wdt:P648' }`. The expected value remains
`{ type: 'value', content: key.split('/').at(-1) }`. Evaluating the side-effect-free property conditional in a local
between the two assertions preserves the compared values and assertion order.

## Full helper diff

```diff
--- approved helper
+++ proposed helper
@@ -1,7 +1,8 @@
 function unresolved(statement: BatchStatement | Statement, key: string, wire: 'proposal' | 'native' = 'proposal') {
   expect(statement.value).toEqual({ type: 'somevalue' });
+  const property = wire === 'native' ? { id: 'wdt:P648', data_type: 'external-id' } : { id: 'wdt:P648' };
   expect(statement.qualifiers).toContainEqual<Statement['qualifiers'] | NonNullable<BatchStatement['qualifiers']>>({
-    property: wire === 'native' ? { id: 'wdt:P648', data_type: 'external-id' } : { id: 'wdt:P648' },
+    property,
     value: { type: 'value', content: key.split('/').at(-1) },
   });
 }
```

## Compiler evidence

Both compiler invocations use the contract's affected-workspace root typecheck. This checks the kernel with its
actual installed types; it is not a root full-workspace gate or a kernel runtime test gate. No native fixture was
started. There are exactly two compiler runs: the committed baseline and the committed candidate.

### Baseline

Committed probe: `0dfbe27fcf`.

```sh
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/known-reference-matcher-type-probe.ts bun scripts/typecheck.ts
bun scripts/worker-check.ts --wait fc65cf0b-ef8b-4089-9936-0571a31df60c
```

Check ID: `fc65cf0b-ef8b-4089-9936-0571a31df60c`. Terminal exit status: `1`.
This reproduces the reported `TS2353` diagnostic at probe line 8, column 53, corresponding to the frozen helper's
native property expression at line 73, column 53. There is no disagreement with the reported compiler failure.
Full check log:

```text
remote-check: slot wait 248.695 s on b

Number of files: 5,326 (reg: 4,995, dir: 330, link: 1)
Number of created files: 14 (reg: 14)
Number of deleted files: 0
Number of regular files transferred: 54
Total file size: 57,630,258 bytes
Total transferred file size: 853,798 bytes
Literal data: 225,767 bytes
Matched data: 628,031 bytes
File list size: 196,593
File list generation time: 0.820 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 305,528
Total bytes received: 23,368

sent 305,528 bytes  received 23,368 bytes  19,933.09 bytes/sec
total size is 57,630,258  speedup is 175.22
remote-check: rsync 17.729 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [423.00ms]
Checking 1 of 13 workspaces the change can affect.
Resolving dependencies
Resolved, downloaded and extracted [1]
remote-check: bun install 0.439 s on b
Workspace @rezics/kernel finished in 84.79s
$ bun run typecheck  (services/kernel)
test/imports/known-reference-matcher-type-probe.ts(8,53): error TS2353: Object literal may only specify known properties, and 'data_type' does not exist in type '{ id: string; }'.
$ bun scripts/typecheck.ts

remote-check: command 89.031 s on b
remote-check: run used 112.826 CPU seconds over 89.634 s (1.26 cores), peak memory 2894 MiB on b
worker-check: env TYPECHECK_CHANGED=services/kernel/test/imports/known-reference-matcher-type-probe.ts bun scripts/typecheck.ts peak 2.8 GiB (weight 4)
check: exit status 1
check: failure summary
Total bytes received: 23,368
sent 305,528 bytes  received 23,368 bytes  19,933.09 bytes/sec
test/imports/known-reference-matcher-type-probe.ts(8,53): error TS2353: Object literal may only specify known properties, and 'data_type' does not exist in type '{ id: string; }'.
check: log .temp/goal/checks/worker-check-2026-10-29T14-27-07.499Z-34ce7a97.log
```

### Candidate

Committed probe: `be46e3405c`.

```sh
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/known-reference-matcher-type-probe.ts bun scripts/typecheck.ts
bun scripts/worker-check.ts --wait 45a5d530-7a91-48f3-bf70-8fc8da3ff28a
```

Check ID: `45a5d530-7a91-48f3-bf70-8fc8da3ff28a`. Terminal exit status: `0`.
The first wait returned status `75` with `check: still running`; the same `--wait` command was issued again and
returned terminal status `0`. No second compiler run or infrastructure rerun was started. The affected kernel
workspace passed, including its normal compiler and construct steps. This validates this helper with the installed
types; it does not claim that the complete proposed frozen acceptance was compiled or executed.
Full check log:

```text
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (b 1/6 free, a 0/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (b 1/6 free, a 1/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, c 0/3 free, a 0/4 free); skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (a 1/4 free, b 0/6 free, c 0/3 free); skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, c 0/3 free, a 0/4 free); skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, c 0/3 free, a 0/4 free); skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, c 0/3 free, a 0/4 free); skipped c: load 36.5 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (c 1/3 free, b 0/6 free, a 0/4 free); skipped c: load 36.5 exceeds limit 36
remote-check: slot wait 602.589 s on c

Number of files: 5,326 (reg: 4,995, dir: 330, link: 1)
Number of created files: 32 (reg: 30, dir: 2)
Number of deleted files: 0
Number of regular files transferred: 128
Total file size: 57,630,277 bytes
Total transferred file size: 2,544,464 bytes
Literal data: 632,615 bytes
Number of 4 KiB logical blocks touched: 684
Matched data: 1,911,849 bytes
File list size: 196,577
File list generation time: 0.955 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 433,961
Total bytes received: 38,200

sent 433,961 bytes  received 38,200 bytes  188,864.40 bytes/sec
total size is 57,630,277  speedup is 122.06
remote-check: rsync 2.251 s on c
remote-check: running on c
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [1406.00ms]
remote-check: bun install 1.425 s on c
Checking 1 of 13 workspaces the change can affect.
Workspace @rezics/kernel finished in 98.32s
$ bun run typecheck  (services/kernel)

remote-check: command 123.540 s on c
remote-check: run used 148.946 CPU seconds over 125.231 s (1.19 cores), peak memory 2826 MiB on c
worker-check: env TYPECHECK_CHANGED=services/kernel/test/imports/known-reference-matcher-type-probe.ts bun scripts/typecheck.ts peak 2.8 GiB (weight 4)
check: exit status 0
check: log .temp/goal/checks/worker-check-2026-10-29T14-35-39.284Z-c06f17d0.log
```

Artifact delivery acceptance is `test -s docs/research/imports-audit/known-reference-matcher-type-probe.md`,
run separately through the standard worker-check wrapper after this report is committed.

## Proposed acceptance bytes

Approved input SHA-256: `720b74e64eb29d8a1a10403f16c9e9a329d01aab93255fe5c69bc46f97d1db51`.
Full proposed acceptance SHA-256: `f46b81a106c65ed6a37732845c89c94c239affa69105ba47d67fc2d94584dc89`.
The proposed bytes were generated by replacing exactly the old helper above in the approved input with exactly the
new helper. A single occurrence was required; reversing that replacement restored the approved input byte for byte.
The module's only difference from the proposed helper is its export modifier and its three actual type/matcher
imports. The probe imports no runtime fixture and registers no test jobs.

All acceptance bytes outside that helper are identical to the approved input, including both test cases, relay
limit of sixteen, busy sleep of five milliseconds, fatal stopped assertion, empty read termination, business
assertions, identifiers, history, adoption and replay. Existing frozen files remain untouched. The existing
worktree frozen file has SHA-256 `8cce3c28e9bd9ad933a7b9881f3af320c1d337129e20e65c10e19cc77ec5635b`;
it was neither the amendment source nor a replacement destination.

Extract the following single TypeScript block as UTF-8 with its final newline to independently hash the complete
proposal. It requires exact owner approval after manager and Semantic review before installation. This report
neither requests nor starts a continuation.

```ts
import { expect, test } from 'bun:test';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const work = {
  type: { key: '/type/work' },
  key: '/works/OL1W',
  revision: 1,
  title: 'Known native work',
  last_modified: { value: '2025-01-02T03:04:05' },
};
const edition = {
  type: { key: '/type/edition' },
  key: '/books/OL1M',
  revision: 1,
  title: 'Native edition',
  last_modified: { value: '2025-01-02T03:04:05' },
  works: [{ key: work.key }],
  authors: [{ key: '/authors/OL1A' }],
};
const relation = 'schema:exampleOfWork';
type Candidate = { id: string; statement: Statement; revision: number; retracted: number | null };
type Propose = Extract<BatchCommand, { op: 'propose' }>;
const owner = (key: string) => ({ source: 'openlibrary', external_id: key });
function dump(records: readonly (typeof work | typeof edition)[]): Dump {
  return {
    source: 'openlibrary',
    snapshot: 'native-reference-control',
    converterRevision: converter_revision,
    bytes: new TextEncoder().encode(
      records
        .map((r) => [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(r)].join('\t'))
        .join('\n') + '\n',
    ),
  };
}
const commands = (run: Run) => run.exchanges.flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands);
function proposal(run: Run, property: string) {
  return commands(run).find(
    (c): c is Propose =>
      c.op === 'propose' && c.source.external_id === edition.key && c.statement.property.id === property,
  );
}
function completed(run: Run) {
  expect(run.outcome).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    for (const result of (exchange.response.body as BatchWriteResult).results) expect(result.status).toBeLessThan(400);
  }
}
// Point-read only the successful own binding, and retain its actual public claim response.
function claim(runtime: ApiRuntime, run: Run, key: string) {
  const create = commands(run).find((c) => c.op === 'create' && c.source.external_id === key);
  expect(create).toBeDefined();
  const result = run.exchanges
    .flatMap((e) => (e.response.body as BatchWriteResult).results)
    .find((r) => r.key === create!.key);
  if (!result || !('value' in result) || !('id' in result.value)) throw new Error('Missing real claim response');
  expect([200, 201]).toContain(result.status);
  const binding = runtime.importer.session.bindings.claim(owner(key));
  expect(binding).toEqual({ state: 'bound', subject: result.value.id });
  return { id: result.value.id, response: result, binding };
}
function unresolved(statement: BatchStatement | Statement, key: string, wire: 'proposal' | 'native' = 'proposal') {
  expect(statement.value).toEqual({ type: 'somevalue' });
  const property = wire === 'native' ? { id: 'wdt:P648', data_type: 'external-id' } : { id: 'wdt:P648' };
  expect(statement.qualifiers).toContainEqual<Statement['qualifiers'] | NonNullable<BatchStatement['qualifiers']>>({
    property,
    value: { type: 'value', content: key.split('/').at(-1) },
  });
}
async function open() {
  // Same construction as the platform API controls: no identifierLookup callback.
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    async function candidates(id: string, property: string, context?: string, target?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          limit: '100',
          ...(context ? { context } : {}),
          ...(target ? { target } : {}),
        })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as Candidate[];
    }
    async function adopt(id: string, property: string, candidate: string, context: string, target?: string) {
      const listing = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context, limit: '100', ...(target ? { target } : {}) })}`,
      );
      expect(listing.status).toBe(200);
      expect(listing.body.next).toBeNull();
      expect((listing.body.candidates as Candidate[]).some((row) => row.id === candidate)).toBe(true);
      expect(
        (await editor.http(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null }))
          .status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context,
            property,
            ...(target ? { target } : {}),
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            expected_head: (listing.body.adoption as { head: number } | null)?.head ?? null,
          })
        ).status,
      ).toBe(200);
      // Deliver the real bounded subject-partition relay before testing relation disclosure.
      const links = linkProjection(runtime.database.pool);
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const delivered = await links.run(partitionOf(routeOf(id)!));
        expect(delivered.status).not.toBe('stopped');
        if (delivered.status === 'busy') {
          await Bun.sleep(5);
          continue;
        }
        if (delivered.status === 'read' && delivered.envelopes === 0) {
          caughtUp = true;
          break;
        }
      }
      expect(caughtUp).toBe(true);
    }
    return { runtime, editor, candidates, adopt };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

test('an importer reference resolves only through actual known native claims without invented identity or revision', async () => {
  const { runtime, editor, candidates, adopt } = await open();
  try {
    const first = await runtime.run(dump([work]));
    completed(first);
    const known = claim(runtime, first, work.key);
    // A complete dump retains the work; no accidental disappearance/retraction control.
    const second = await runtime.run(dump([work, edition]));
    completed(second);
    const book = claim(runtime, second, edition.key);
    const author = proposal(second, 'schema:author');
    expect(author).toBeDefined();
    unresolved(author!.statement, '/authors/OL1A');
    expect(runtime.importer.session.bindings.claim(owner('/authors/OL1A'))).toBeNull();
    const rows = await candidates(book.id, relation, undefined, known.id);
    expect(rows).toHaveLength(1);
    const resolved = proposal(second, relation);
    expect(resolved).toBeDefined();
    expect(resolved!.source.record_revision).toBe('1');
    expect(resolved!.source.converter_revision).toBe(converter_revision);
    // Expected red on the default platform path: knowing the own claim is not handed to conversion.
    expect(resolved!.statement.value).toEqual({ type: 'value', content: known.id });
    expect(rows[0]!.statement.value).toEqual({ type: 'value', content: known.id });
    // Use only the retrieved candidate; never synthesize a manual replacement to make adoption pass.
    const contextResponse = await editor.http('/v1/contexts', { labels: { en: 'Native resolved reference review' } });
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    await adopt(book.id, relation, rows[0]!.id, context, known.id);
    completed(await runtime.run(dump([work, edition])));
    expect(await candidates(book.id, relation, undefined, known.id)).toEqual(rows);
    await runtime.identity.setBulkPermission(false);
    const exchange = second.exchanges.find((e) => e.request.keys.includes(resolved!.key))!;
    const denied = await runtime.replay(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers: exchange.request.headers,
        body: exchange.request.serializedBody,
      }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(known.id);
    expect(runtime.importer.session.bindings.claim(owner(work.key))).toEqual(known.binding);
    expect(await candidates(book.id, relation, undefined, known.id)).toEqual(rows);
  } finally {
    await runtime.close();
  }
}, 600_000);

test('the same session refreshes an unchanged native edition after learning its real work claim', async () => {
  const { runtime, editor, candidates, adopt } = await open();
  try {
    const first = await runtime.run(dump([edition]));
    completed(first);
    const book = claim(runtime, first, edition.key);
    const old = proposal(first, relation)!;
    unresolved(old.statement, work.key);
    const before = await candidates(book.id, relation);
    expect(before).toHaveLength(1);
    const oldCandidate = before[0]!;
    const contextResponse = await editor.http('/v1/contexts', { labels: { en: 'Native reference review' } });
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    await adopt(book.id, relation, oldCandidate.id, context);
    const learned = await runtime.run(dump([edition, work]));
    completed(learned);
    const known = claim(runtime, learned, work.key);
    expect(runtime.importer.session.bindings.claim(owner(work.key))).toEqual(known.binding);
    const refreshed = await runtime.run(dump([edition, work]));
    completed(refreshed);
    const after = await candidates(book.id, relation, context, known.id);
    const unresolvedAfter = await candidates(book.id, relation, context);
    const resolved = after.find((c) => c.statement.value.type === 'value' && c.statement.value.content === known.id);
    // Learning may refresh in that complete dump or in the subsequent unchanged import.
    expect(resolved).toBeDefined();
    const fresh = proposal(learned, relation) ?? proposal(refreshed, relation);
    expect(fresh).toBeDefined();
    expect(fresh!.key).not.toBe(old.key);
    expect(fresh!.statement).not.toEqual(old.statement);
    expect(fresh!.source).toEqual(old.source); // data-only digest and both real revisions stay stable
    expect(resolved!.id).not.toBe(oldCandidate.id);
    const retained = unresolvedAfter.find((c) => c.id === oldCandidate.id);
    expect(retained?.statement).toEqual(oldCandidate.statement);
    expect(retained?.revision).toBe(oldCandidate.revision);
    // Source retraction does not silently undo the community's earlier adoption.
    const adopted = await editor.http(`/v1/subjects/${book.id}?context=${context}`);
    expect(adopted.status).toBe(200);
    const subject = adopted.body.subject as { statements: Record<string, BatchStatement[]> };
    expect(subject.statements[relation]?.some((s) => s.value.type === 'somevalue')).toBe(true);
    await adopt(book.id, relation, resolved!.id, context, known.id);
    const selected = await editor.http(`/v1/subjects/${book.id}?context=${context}`);
    expect(selected.status).toBe(200);
    expect(
      (selected.body.subject as typeof subject).statements[relation]?.some(
        (s) => s.value.type === 'value' && s.value.content === known.id,
      ),
    ).toBe(true);
    const history = await candidates(book.id, relation, context, known.id);
    const unresolvedHistory = await candidates(book.id, relation, context);
    expect(unresolvedHistory.some((c) => c.id === oldCandidate.id)).toBe(true);
    completed(await runtime.run(dump([edition, work])));
    expect(await candidates(book.id, relation, context, known.id)).toEqual(history);
    expect(await candidates(book.id, relation, context)).toEqual(unresolvedHistory);
    const author = await candidates(book.id, 'schema:author');
    expect(author).toHaveLength(1);
    unresolved(author[0]!.statement, '/authors/OL1A', 'native');
  } finally {
    await runtime.close();
  }
}, 600_000);
```

## Scope, sources and retained evidence

Only the declared probe and this report are changed. There are no outside-path changes. No product, runtime,
schema, dependency, assertion file, frozen file, controller brief or settings were edited. Temporary proposal and
baseline evidence are retained only under this worktree's `.temp/goal/imports/`.

Read in full: the historical frozen acceptance obtained with
`git show 24b51e8423c6b9b16f96ac93d7d7070265391089:services/kernel/test/imports/known-reference-refresh.test.ts`;
the read-only main checkout's exact `.temp/goal/imports/known-reference-matcher-typing-review.md` and
`.temp/goal/imports/proposed-known-reference-matcher-typing.test.ts`. Primary type surfaces read:
`services/kernel/src/semantic/item.ts` (`Statement`, `Snak`, `Value`),
`packages/definitions/src/bulk.ts` (optional qualifiers and id-only snaks), and the installed
`bun-types/test.d.ts` matcher overloads with its package metadata and TypeScript-specific entry point.
No reference project source is named by this contract, so no external project research was needed.

The previously supplied local two-case pass and adjacent eleven-suite pass remain reused historical evidence;
neither was rerun or promoted to fresh evidence. The only new executable evidence is compiler compatibility of
the bounded helper probe. Full native acceptance and owner approval remain separate work.
