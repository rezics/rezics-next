import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const rows = [
  {
    id: 499,
    type: 1,
    name: '文学少女',
    name_cn: '文学少女',
    platform: 1002,
    series: true,
    date: '2006-04-28',
    infobox: '{{Infobox animanga/Novel\r\n|作者= 野村美月\r\n|册数= 8+8(番外)\r\n}}',
  },
  {
    id: 26,
    type: 1,
    name: '“文学少女”と死にたがりの道化',
    name_cn: '“文学少女”与渴望死亡的小丑',
    platform: 1002,
    series: false,
    date: '2006-04-28',
    infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757728066\r\n|出版社= エンターブレイン\r\n|页数= 254\r\n}}',
  },
  {
    id: 27,
    type: 1,
    name: '“文学少女”と飢え渇く幽霊',
    platform: 1002,
    series: false,
    date: '2006-08-30',
    infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757729155\r\n}}',
  },
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

test('reader keeps book, volume and author identities after accept, adopt and one refresh', async () => {
  expect(createSourceRegistration('bangumi').converter_revision).toBe(converter_revision);
  expect(initial.outcome).toBe('complete');
  expect(rows.map((row) => binding(row.id)).every(Boolean)).toBe(true);
  expect(binding(9001)).toBeNull();
  expect(binding(9002)).toBeNull();
  for (const [id, type] of [
    [499, 'schema:BookSeries'],
    [26, 'schema:Book'],
    [27, 'schema:Book'],
  ] as const) {
    const view = await subject(id);
    expect(view.type).toBe(type);
    expect(view.labels).toMatchObject({ und: rows.find((row) => row.id === id)!.name });
    expect(view.sourceRecords?.some((record) => record.source === 'bangumi' && record.external_id === String(id))).toBe(
      true,
    );
    expect(bundledRelease.types[type]).toBeDefined();
    const names = await observer.http(`/v1/subjects/${binding(id)}/candidates?property=schema%3Aname&limit=20`);
    expect(names.status).toBe(200);
    expect(
      (names.body.candidates as { statement: { value: { content: { text: string } } } }[]).some(
        (row) => row.statement.value.content.text === rows.find((item) => item.id === id)!.name,
      ),
    ).toBe(true);
  }
  const volume = await subject(26);
  expect(JSON.stringify(volume.statements)).not.toContain('9784757728066');
  const published = await observer.http(
    `/v1/subjects/${binding(26)}/candidates?property=schema%3AdatePublished&limit=20`,
  );
  expect(published.status).toBe(200);
  expect(
    (published.body.candidates as { statement: { value: { content: { time: string; precision: number } } } }[]).some(
      (row) =>
        row.statement.value.content.time === '+2006-04-28T00:00:00Z' && row.statement.value.content.precision === 11,
    ),
  ).toBe(true);
  const seriesId = binding(499)!;
  const volumeId = binding(26)!;
  const offset = runtime.captures.length;
  const repeated = await runtime.run(dump());
  expect(repeated.outcome).toBe('complete');
  expect(binding(499)).toBe(seriesId);
  expect(binding(26)).toBe(volumeId);
  expect(runtime.captures.slice(offset).filter((capture) => capture.request.method === 'POST')).toEqual([]);
}, 600_000);
