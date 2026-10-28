import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { readDump } from '../../../importer/src/dumps.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const types = [1, 2, 4, 3, 6];
const marker = 'PRIVATE_LAUNCH_SCOPE_SENTINEL';
// Controlled source input in the published subject shape; no derived server output.
const records = (changed = false) =>
  types.map((type) => ({
    id: type,
    type,
    name: changed && type === 1 ? 'Changed book' : `Launch title ${type}`,
    name_cn: `中文标题 ${type}`,
    images: { large: 'https://lain.bgm.tv/cover.jpg' },
    posts: [marker],
  }));
const dump = (rows: unknown[]): Dump => ({
  source: 'bangumi',
  snapshot: 'label-only-not-a-source-revision',
  converterRevision: converter_revision,
  bytes: new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
});
let runtime: ApiRuntime;
let observer: Awaited<ReturnType<typeof openApiObserver>>;
let initial: Run;
beforeAll(async () => {
  runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  observer = await openApiObserver(runtime);
  initial = await runtime.run(dump(records()));
}, 600_000);
afterAll(async () => {
  await runtime?.close();
}, 600_000);

function commands(run: Run) {
  return run.exchanges.flatMap((exchange) => (exchange.request.body as { commands: BatchCommand[] }).commands);
}
function binding(id: number) {
  const claim = runtime.importer.session.bindings.claim({ source: 'bangumi', external_id: String(id) });
  return claim?.state === 'bound' ? claim.subject : null;
}
function membership() {
  const store = runtime.importer.session.store;
  expect(store.source('bangumi').count).toBe(5);
  expect(store.source('bangumi').generation).not.toBeNull();
  for (const id of types) {
    const row = store.key('bangumi', String(id));
    expect(row.baseline).toMatchObject({
      source: 'bangumi',
      recordKey: String(id),
      state: 'present',
      recordRevision: 'unversioned',
    });
    expect(row.acknowledged).toEqual(row.baseline);
  }
}
async function receipts(run: Run) {
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    expect(exchange.receipts.length).toBe(exchange.request.keys.length);
    for (const receipt of exchange.receipts) {
      expect(receipt.identity).not.toBeNull();
      expect(await runtime.receipt(receipt.key)).toBe(receipt.identity);
    }
  }
}
async function subject(id: number) {
  const key = binding(id);
  expect(key).not.toBeNull();
  const response = await observer.http(`/v1/subjects/${key}`);
  expect(response.status).toBe(200);
  return response.body.subject as Subject;
}
async function titles(id: number) {
  const response = await observer.http(`/v1/subjects/${binding(id)}/candidates?property=schema%3Aname&limit=20`);
  expect(response.status).toBe(200);
  return response.body.candidates as {
    id: string;
    source: {
      source: string;
      external_id: string;
      record_revision: string;
      converter_revision: string;
      digest: string;
    };
    statement: { value: { content: { text: string } } };
  }[];
}
function writesSince(offset: number) {
  return runtime.captures.slice(offset).filter((c) => c.request.method === 'POST');
}

test('mixed complete JSON-lines import creates only three native subjects and no skipped output', async () => {
  expect(initial.outcome).toBe('complete');
  membership();
  await receipts(initial);
  const native = await Promise.all(types.map(async (id) => (binding(id) ? subject(id) : null)));
  expect(native.filter(Boolean)).toHaveLength(3);
  expect(types.filter((id) => binding(id) !== null)).toEqual([1, 2, 4]);
  expect(commands(initial).some((c) => ['3', '6'].includes(c.source.external_id))).toBe(false);
  const media = runtime.captures.filter((c) => new URL(c.request.url).pathname === '/v1/media:importFromUrl');
  expect(media).toHaveLength(3);
  expect(media.map((c) => JSON.parse(c.body).containerId).sort()).toEqual([1, 2, 4].map(binding).sort());
  for (const capture of runtime.captures) expect(capture.body).not.toContain(marker);
}, 600_000);

test('supported native public types and proposals preserve real identity and absent revision', async () => {
  expect(initial.outcome).toBe('complete');
  for (const [id, type] of [
    [1, 'schema:Book'],
    [2, 'schema:TVSeries'],
    [4, 'schema:VideoGame'],
  ] as const) {
    const view = await subject(id);
    expect(view.type).toBe(type);
    expect(view.labels).toMatchObject({ und: `Launch title ${id}`, zh: `中文标题 ${id}` });
    const rows = await titles(id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toMatchObject({
        source: 'bangumi',
        external_id: String(id),
        record_revision: 'unversioned',
        converter_revision,
      });
      expect(row.source.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(rows.some((row) => row.statement.value.content.text === `Launch title ${id}`)).toBe(true);
  }
  for (const command of commands(initial)) {
    expect(command.source.record_revision).toBe('unversioned');
    expect(command.source.source).toBe('bangumi');
  }
}, 600_000);

test('reopen unchanged and change book preserve identity and all five members without disappearance', async () => {
  const ids = types.map(binding);
  const before = await Promise.all([1, 2, 4].map(subject));
  const previous = await titles(1);
  await runtime.restart();
  const offset = runtime.captures.length;
  const repeated = await runtime.run(dump(records()));
  expect(repeated.outcome).toBe('complete');
  expect(repeated.vanished).toEqual([]);
  expect(writesSince(offset)).toEqual([]);
  expect(await Promise.all([1, 2, 4].map(subject))).toEqual(before);
  membership();
  const changed = await runtime.run(dump(records(true)));
  expect(changed.outcome).toBe('complete');
  expect(changed.vanished).toEqual([]);
  expect(types.map(binding)).toEqual(ids);
  membership();
  await receipts(changed);
  expect(commands(changed).length).toBeGreaterThan(0);
  expect(commands(changed).every((c) => c.source.external_id === '1')).toBe(true);
  expect(commands(changed).some((c) => c.op === 'propose')).toBe(true);
  const refreshed = await titles(1);
  const added = refreshed.filter((row) => !previous.some((old) => old.id === row.id));
  expect(added.some((row) => row.statement.value.content.text === 'Changed book')).toBe(true);
  expect(added.every((row) => row.source.record_revision === 'unversioned')).toBe(true);
  expect(added.every((row) => row.source.digest !== previous[0]!.source.digest)).toBe(true);
  expect(await subject(2)).toEqual(before[1]!);
  expect(await subject(4)).toEqual(before[2]!);
  expect(binding(3)).toBeNull();
  expect(binding(6)).toBeNull();
}, 600_000);

test('unsupported and malformed types reject complete acquisition before native effects', async () => {
  const baseline = runtime.importer.session.store.source('bangumi');
  const views = await Promise.all([1, 2, 4].map(subject));
  for (const type of [0, 5, 7, '1', null, 1.5, undefined]) {
    const offset = runtime.captures.length;
    // Valid input precedes the invalid row: sealing must precede all effects.
    const invalid = { ...records()[0], id: 99, type };
    const result = await runtime.run(dump([records(true)[0], invalid]));
    expect(result.outcome).toBe('invalid-input');
    expect(result.exchanges).toEqual([]);
    expect(writesSince(offset)).toEqual([]);
    expect(binding(99)).toBeNull();
    expect(runtime.importer.session.store.source('bangumi')).toEqual(baseline);
    expect(await Promise.all([1, 2, 4].map(subject))).toEqual(views);
  }
}, 600_000);

test('existing native importer seam returns genuine skipped count on unchanged complete membership', async () => {
  // Direct unchanged invocation needs no runtime exchange translation or manufactured result.
  // Return to the original bytes first, independently of earlier assertion failures.
  expect((await runtime.run(dump(records()))).outcome).toBe('complete');
  await runtime.restart();
  const offset = runtime.captures.length;
  const bytes = dump(records()).bytes;
  const input = readDump(
    'bangumi',
    (async function* () {
      yield bytes;
    })(),
    { maxRecordBytes: 65536 },
  );
  const result = await runtime.importer.runRecords(createSourceRegistration('bangumi'), input, {
    maxRecordBytes: 65536,
  });
  expect(result.status).toBe('committed');
  expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: 5, vanished: 0 });
  expect(result.vanished).toEqual([]);
  expect(writesSince(offset)).toEqual([]);
  membership();
  expect(result).toHaveProperty('skipped', 2);
}, 600_000);
