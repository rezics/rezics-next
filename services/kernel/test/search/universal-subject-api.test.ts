import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDriverClient } from './support/driver-client.ts';
import type { SearchDriver } from '../../../../specs/search-driver.ts';

const client = createDriverClient();
let driver: SearchDriver;
const marker = `universalkind${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const subjects = new Map<string, { type: string; title: string }>();
const search = (body: Record<string, unknown> = {}, persona: 'anonymous' | 'editor' | 'suspended' = 'anonymous') =>
  driver.request(persona, 'POST', '/v1/subjects:search', { text: marker, languages: ['en'], ...body });

beforeAll(async () => {
  driver = await client.init();
  for (const [type, name] of [
    ['schema:Book', 'A book'],
    ['schema:Person', 'B person'],
    ['schema:Recipe', 'C recipe'],
  ]) {
    const title = `${name} ${marker}`;
    const created = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      { type, labels: { en: title }, descriptions: { en: marker } },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(created.status).toBe(201);
    const subject = created.body.subject as { id: string };
    subjects.set(subject.id, { type: type!, title });
  }
  const until = performance.now() + 30_000;
  while (true) {
    const response = await search();
    if (response.status === 200 && (response.body.subjects as { id: string }[]).length === subjects.size) break;
    if (performance.now() >= until)
      throw new Error(`Native projection baseline not ready: ${JSON.stringify(response.body)}`);
    await Bun.sleep(100);
  }
}, 240_000);
afterAll(async () => {
  await client.close();
}, 240_000);

test('one native request mixes configured subject kinds and carries public generic bases', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    const response = await search({}, persona);
    expect(response.status).toBe(200);
    const hits = response.body.subjects as Record<string, unknown>[];
    expect(new Set(hits.map((hit) => hit.id))).toEqual(new Set(subjects.keys()));
    for (const hit of hits) {
      const original = subjects.get(hit.id as string)!;
      expect(hit.type).toBe(original.type);
      expect(hit.kind).toBe(original.type);
      const base = hit.base as Record<string, unknown>;
      expect(base.id).toBe(hit.id);
      expect(base.kind).toBe(hit.type);
      expect(base.title).toEqual({ value: original.title, language: 'en' });
      expect(base.image).toBeNull();
      expect(base.url).toEqual({ id: hit.id, label: { value: original.title, language: 'en' } });
      expect((base.kindLabel as { value: string }).value.length).toBeGreaterThan(0);
    }
    expect(response.body).not.toHaveProperty('total');
  }
}, 120_000);

test('the existing type condition selects one kind without a separate endpoint', async () => {
  const response = await search({ filter: { type: { in: ['schema:Book'] } } });
  expect(response.status).toBe(200);
  const hits = response.body.subjects as { type: string; kind: string }[];
  expect(hits.length).toBe(1);
  expect(hits[0]!.kind).toBe('schema:Book');
  const kinds = response.body.kinds as { values: { value: string; count?: { value: number; exact: boolean } }[] };
  const book = kinds.values.find((kind) => kind.value === 'schema:Book');
  expect(book?.count).toEqual({ value: 1, exact: false });
  expect(kinds.values.every((kind) => kind.count === undefined || kind.count.value > 0)).toBe(true);
}, 120_000);

test('NOT remains closed to anonymous and editor callers when only basic search is open', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    const response = await search(
      { filter: { and: [{ type: { in: ['schema:Book'] } }, { not: { type: { in: ['schema:Recipe'] } } }] } },
      persona,
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('platform_closed');
    expect(response.body).not.toHaveProperty('subjects');
    expect(response.body).not.toHaveProperty('kinds');
    expect(response.body).not.toHaveProperty('total');
  }
}, 120_000);

test('kind metadata pages are opaque and hit continuations do not repeat counts', async () => {
  const initial = await search({ limit: 1, sort: 'id' });
  expect(initial.status).toBe(200);
  const kinds = initial.body.kinds as { values: { value: string }[]; next: string | null };
  expect(kinds.values.length).toBeGreaterThan(0);
  expect(kinds.values.length).toBeLessThanOrEqual(8);
  expect(typeof kinds.next).toBe('string');
  expect(kinds.values.map((kind) => kind.value)).not.toContain(kinds.next);
  const more = await search({ limit: 1, sort: 'id', kindCursor: kinds.next });
  expect(more.status).toBe(200);
  const laterKinds = more.body.kinds as { values: { value: string; count?: unknown }[] };
  expect(laterKinds.values.every((kind) => kind.count === undefined)).toBe(true);
  expect(laterKinds.values.every((kind) => !kinds.values.some((first) => first.value === kind.value))).toBe(true);
  expect(typeof initial.body.next).toBe('string');
  const next = await search({ limit: 1, sort: 'id', cursor: initial.body.next });
  expect(next.status).toBe(200);
  const continued = next.body.kinds as { values: { count?: unknown }[] } | undefined;
  expect(continued === undefined || continued.values.every((kind) => kind.count === undefined)).toBe(true);
  const invalid = await search({ kindCursor: 'schema:Book' });
  expect(invalid.status).toBe(400);
}, 120_000);

test('the native pre-suspension bearer remains refused before the search route', async () => {
  const response = await search({}, 'suspended');
  expect(response.status).toBe(401);
  expect(response.body.code).toBe('invalid_credentials');
  expect(response.headers.get('www-authenticate')).toContain('invalid_token');
}, 120_000);

test('hidden and taken-down subjects never enter generic bases or kind count witnesses', async () => {
  const book = [...subjects].find(([, value]) => value.type === 'schema:Book')!;
  const recipe = [...subjects].find(([, value]) => value.type === 'schema:Recipe')!;
  await driver.remove(book[0], 'hidden');
  await driver.remove(recipe[0], 'taken_down');
  const until = performance.now() + 30_000;
  while (true) {
    const response = await search();
    expect(JSON.stringify(response.body)).not.toContain(book[0]);
    expect(JSON.stringify(response.body)).not.toContain(recipe[0]);
    if (response.status === 200) {
      expect((response.body.subjects as { id: string }[]).length).toBe(1);
      const kinds = response.body.kinds as { values: { value: string; count?: { value: number } }[] };
      const count = kinds.values.find((kind) => kind.value === 'schema:Book')?.count;
      expect(count === undefined || count.value === 0).toBe(true);
      break;
    }
    expect(response.status).toBe(503);
    if (performance.now() >= until)
      throw new Error('Native projection did not become ready after hidden/taken-down reductions');
    await Bun.sleep(100);
  }
}, 120_000);
