import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const rows = [
  { id: 3, type: 3, name: 'Soundtrack', name_cn: '原声集', date: '2024-04-01' },
  { id: 6, type: 6, name: 'Live film', name_cn: '真人电影', platform: 6002, date: '2024-05' },
  { id: 61, type: 6, name: 'Live series', name_cn: '电视剧', platform: '6001' },
];
const dump = (): Dump => ({
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
  initial = await runtime.run(dump());
}, 600_000);
afterAll(async () => {
  await runtime?.close();
}, 600_000);

function binding(id: number) {
  const claim = runtime.importer.session.bindings.claim({ source: 'bangumi', external_id: String(id) });
  return claim?.state === 'bound' ? claim.subject : null;
}
async function subject(id: number) {
  const response = await observer.http(`/v1/subjects/${binding(id)}`);
  expect(response.status).toBe(200);
  return response.body.subject as Subject & { sourceRecords?: { source: string; external_id: string }[] };
}

test('ordinary Bangumi music and live-action imports are typed subjects with source provenance', async () => {
  expect(createSourceRegistration('bangumi').converter_revision).toBe(converter_revision);
  expect(initial.outcome).toBe('complete');
  expect(rows.map((row) => binding(row.id)).every(Boolean)).toBe(true);
  for (const [id, type] of [
    [3, 'schema:MusicAlbum'],
    [6, 'schema:Movie'],
    [61, 'schema:TVSeries'],
  ] as const) {
    const view = await subject(id);
    expect(view.type).toBe(type);
    expect(view.labels).toMatchObject({ und: rows.find((row) => row.id === id)!.name });
    expect(view.sourceRecords?.some((record) => record.source === 'bangumi' && record.external_id === String(id))).toBe(
      true,
    );
    const admitted = bundledRelease.types[type];
    expect(admitted).toBeDefined();
    if (type === 'schema:Movie' || type === 'schema:TVSeries') expect(admitted?.library?.profileId).toBeString();
    else expect(admitted?.library).toBeUndefined();
    const names = await observer.http(`/v1/subjects/${binding(id)}/candidates?property=schema%3Aname&limit=20`);
    expect(names.status).toBe(200);
    expect((names.body.candidates as { statement: { value: { content: { text: string } } } }[]).some((row) => row.statement.value.content.text === rows.find((row) => row.id === id)!.name)).toBe(
      true,
    );
  }
  const published = await observer.http(`/v1/subjects/${binding(3)}/candidates?property=schema%3AdatePublished&limit=20`);
  expect(published.status).toBe(200);
  expect(
    (published.body.candidates as { statement: { value: { content: { time: string; precision: number } } } }[]).some(
      (row) => row.statement.value.content.time === '+2024-04-01T00:00:00Z' && row.statement.value.content.precision === 11,
    ),
  ).toBe(true);
  const offset = runtime.captures.length;
  const repeated = await runtime.run(dump());
  expect(repeated.outcome).toBe('complete');
  expect(runtime.captures.slice(offset).filter((capture) => capture.request.method === 'POST')).toEqual([]);
}, 600_000);
