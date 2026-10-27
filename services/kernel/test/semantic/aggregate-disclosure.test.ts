import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { aggregateFixture, property, statement, type AggregateFixture } from './support/aggregate-disclosure.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let fixture: AggregateFixture;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  fixture = await aggregateFixture(db);
});
afterAll(async () => {
  if (db) await db.close();
});

function omitted(value: Record<string, any>) {
  expect(value).not.toHaveProperty('count');
  for (const name of ['total', 'totalCount', 'hiddenCount', 'has_hidden', 'count_omitted_because_hidden'])
    expect(value).not.toHaveProperty(name);
}

test('a public aggregate without current source-safe proof is omitted while skeleton counters remain internal', async () => {
  const target = await fixture.create('Count target');
  const sources = [];
  for (let i = 0; i < 8; i++) sources.push(await fixture.create(`Source ${i}`, [target.id]));
  await fixture.drain();
  expect(await fixture.stored(target.id)).toBe(8);
  // Four candidates including lookahead cannot prove the entire eight-source set.
  const measured = await capture(db, () => fixture.inverse(target.id, '&limit=3'));
  expect(measured.value.links).toHaveLength(3);
  expect(measured.value.links[0].summary.label.value).toBe('Source 0');
  expect(measured.value.next).toEqual(expect.any(String));
  expect(measured.value.freshness.consistency).toBe('eventual');
  expect(measured.capture.statements.some((sql) => /access\./.test(sql))).toBe(true);
  omitted(measured.value);
  expect(await fixture.stored(target.id)).toBe(8);
});

test('paused consumers cannot retain exact public totals after source revocation or takedown', async () => {
  const failures: string[] = [];
  // Each case reaches its native command independently; a failing omission cannot conceal takedown evidence.
  for (const verb of ['hide', 'takedown'] as const) {
    const target = await fixture.create(`Target ${verb}`);
    const source = await fixture.create(`Source ${verb}`, [target.id]);
    await fixture.drain();
    expect((await fixture.inverse(target.id)).links.map((row: any) => row.subject)).toEqual([source.id]);
    expect(await fixture.stored(target.id)).toBe(1);
    await fixture.hide(source.id, verb);
    const response = await fixture.inverse(target.id);
    expect(response.links).toEqual([]);
    expect(await fixture.stored(target.id)).toBe(1);
    expect(response.next).toBeNull();
    expect(response.freshness.consistency).toBe('eventual');
    if (Object.hasOwn(response, 'count')) failures.push(`${verb}: ${JSON.stringify(response)}`);
  }
  // Revocation of imported tuple authority is a real native command, not a fake Access decision.
  const target = await fixture.create('Tuple target');
  const externalId = `aggregate-${randomUUID()}`;
  const provenance = {
    source: 'openlibrary',
    external_id: externalId,
    record_revision: 'unversioned',
    digest: 'c'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  const batch = await fixture.call('POST', '/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'create',
        key: randomUUID(),
        source: provenance,
        subject: {
          type: 'schema:Book',
          labels: { en: 'Imported source' },
        },
      },
    ],
  });
  expect(batch.results[0].status, JSON.stringify(batch)).toBe(201);
  const source = batch.results[0].value.id as string;
  // Batch create admits only subject terms; imported relations are proposed, accepted and adopted.
  const proposed = await fixture.call('POST', '/v1/subjects:batchWrite', {
    commands: [
      { op: 'propose', key: randomUUID(), source: provenance, subject: source, statement: statement(target.id) },
    ],
  });
  expect(proposed.results[0].status, JSON.stringify(proposed)).toBe(201);
  const candidate = proposed.results[0].value.candidate as string;
  await fixture.call('POST', `/v1/subjects/${source}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  await fixture.call('POST', `/v1/subjects/${source}:adopt`, {
    context: GLOBAL_CONTEXT,
    property,
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  fixture.partitions.add(routeOf(source)! >> 4);
  await fixture.drain();
  expect((await fixture.inverse(target.id)).links).toHaveLength(1);
  await fixture.call('POST', '/v1/sourceFences:takedown', {
    source: 'openlibrary',
    externalId,
    fieldGroup: 'facts',
    reason: 'Revoke tuple authority.',
  });
  const revoked = await fixture.inverse(target.id);
  if (revoked.links.length) failures.push(`tuple row leaked: ${JSON.stringify(revoked)}`);
  if (Object.hasOwn(revoked, 'count')) failures.push(`tuple count leaked: ${JSON.stringify(revoked)}`);
  expect(await fixture.stored(target.id)).toBe(1);
  expect(failures).toEqual([]);
});

test('an exhausted currently visible small set may retain its source-safe exact count', async () => {
  const target = await fixture.create('Small target');
  const source = await fixture.create('Small source', [target.id]);
  await fixture.drain();
  const page = await fixture.inverse(target.id, '&limit=3');
  expect(page.links.map((row: any) => row.subject)).toEqual([source.id]);
  expect(page.next).toBeNull();
  // Omission remains valid until production can establish the bounded complete-set proof.
  if (Object.hasOwn(page, 'count')) expect(page.count).toEqual({ value: 1, exact: true });
});

test('relation maps, relation pages and graph truncation omit unproved totals while preserving ordinary rows', async () => {
  const targets = [];
  for (let i = 0; i < 15; i++) targets.push(await fixture.create(`Person ${String(i).padStart(2, '0')}`));
  const source = await fixture.create(
    'Large outgoing source',
    targets.map((row) => row.id),
  );
  await fixture.drain();
  const read = await fixture.call('GET', `/v1/subjects/${source.id}`);
  const page = await fixture.call('GET', `/v1/subjects/${source.id}/relations?property=${property}&limit=3`);
  const graph = await fixture.graph(source.id, 'out');
  expect(read.subject.labels.en).toBe('Large outgoing source');
  expect(read.subject.statements[property]).toHaveLength(12);
  expect(page.relations).toHaveLength(3);
  expect(page.next).toEqual(expect.any(String));
  expect(graph.edges).toHaveLength(1);
  expect(graph.truncated).toHaveLength(1);
  expect({
    map: Object.hasOwn(read.subject.relationCounts, property),
    page: Object.hasOwn(page, 'count'),
    graph: graph.truncated.some((row: any) => Object.hasOwn(row, 'count')),
  }).toEqual({ map: false, page: false, graph: false });
});

test('candidate moderation cannot leave a live row or exact total while consumers pause', async () => {
  const target = await fixture.create('Candidate target');
  const source = await fixture.create('Candidate source', [target.id]);
  const statement = source.statements[property]![0]!.id;
  await fixture.drain();
  await fixture.call('POST', `/v1/subjects/${source.id}/candidates/${statement}:hide`, {
    reason: 'Withhold this relation only.',
  });
  const page = await fixture.inverse(target.id);
  expect(await fixture.stored(target.id)).toBe(1);
  expect(page.links).toEqual([]);
  omitted(page);
});

test('typed inverse counts cannot sample foreign sources outside the page proof budget', async () => {
  const target = await fixture.create('Typed target');
  for (let i = 0; i < 8; i++) await fixture.create(`Typed source ${i}`, [target.id]);
  await fixture.drain();
  const page = await fixture.inverse(target.id, '&limit=1&type=schema:Book');
  expect(page.links).toHaveLength(1);
  expect(page.links[0].type).toBe('schema:Book');
  expect(page.next).toEqual(expect.any(String));
  omitted(page);
});

test('withholding a target removes its row as well as unproved outward totals', async () => {
  const hidden = await fixture.create('A withheld target');
  const visible = await fixture.create('Z retained target');
  const source = await fixture.create('Retained source label', [hidden.id, visible.id]);
  await fixture.drain();
  await fixture.hide(hidden.id, 'takedown');
  const read = await fixture.call('GET', `/v1/subjects/${source.id}`);
  const page = await fixture.call('GET', `/v1/subjects/${source.id}/relations?property=${property}&limit=3`);
  expect(read.subject.labels.en).toBe('Retained source label');
  expect(page.relations.some((row: any) => row.target === visible.id)).toBe(true);
  expect({
    row: page.relations.some((row: any) => row.target === hidden.id),
    preview: read.subject.statements[property]?.some((row: any) => row.value.content === hidden.id) ?? false,
    map: Object.hasOwn(read.subject.relationCounts, property),
    count: Object.hasOwn(page, 'count'),
  }).toEqual({ row: false, preview: false, map: false, count: false });
});
