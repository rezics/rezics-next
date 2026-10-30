import { afterAll, beforeAll, expect, test } from 'bun:test';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
import {
  createCollectionPreviewFixture,
  expectReadyPreview,
  type CollectionPreviewFixture,
} from './support/collection-preview-fixture.ts';

let f: CollectionPreviewFixture;
beforeAll(async () => {
  f = await createCollectionPreviewFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('one native list returns the actual first three summaries for each of two Collections', async () => {
  const first = await f.collection();
  const second = await f.collection();
  const subjects: string[] = [];
  for (let n = 0; n < 8; n++) subjects.push(await f.createSubject('game', `Preview order ${n}`));
  await f.populate(first.id, subjects.slice(0, 4));
  await f.populate(second.id, subjects.slice(4));
  const body = await f.page();
  expectReadyPreview(
    body.collections.find((row) => row.id === first.id),
    subjects.slice(0, 3),
  );
  expectReadyPreview(
    body.collections.find((row) => row.id === second.id),
    subjects.slice(4, 7),
  );
}, 120_000);

test('preview is opt-in, accepts only three, requires FULL, and caps only preview lists at twenty', async () => {
  for (const suffix of [
    '&view=FULL&preview=0',
    '&view=FULL&preview=1',
    '&view=FULL&preview=2',
    '&view=FULL&preview=4',
    '&view=FULL&preview=3.5',
    '&view=FULL&preview=3&limit=21',
    '&view=BASIC&preview=3',
    '&preview=3',
  ])
    expect((await f.list(undefined, suffix)).status).toBe(400);
  for (const suffix of ['', '&view=BASIC&limit=100', '&view=FULL&limit=100']) {
    const body = await f.page(undefined, suffix);
    for (const row of body.collections) {
      expect(Object.hasOwn(row, 'previewStatus')).toBe(false);
      expect(Object.hasOwn(row, 'previewMembers')).toBe(false);
    }
  }
  expect((await f.list(undefined, '&view=FULL&preview=3&limit=20')).status).toBe(200);
}, 120_000);

test('duplicates remain editable occurrences but do not consume canonical preview slots', async () => {
  const collection = await f.collection();
  const a = await f.createSubject('game', 'Duplicate preview A');
  const b = await f.createSubject('recipe', 'Duplicate preview B');
  const c = await f.createSubject('record', 'Duplicate preview C');
  await f.populate(collection.id, [a, a, b, a, c]);
  expectReadyPreview(
    (await f.page()).collections.find((row) => row.id === collection.id),
    [a, b, c],
  );
  const response = await f.send(f.previewOwner.bearer, 'GET', `/v1/collections/${collection.id}/members?limit=100`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { members: { id: string; subjectId: string }[] };
  expect(body.members.map((row) => row.subjectId)).toEqual([a, a, b, a, c]);
  expect(new Set(body.members.map((row) => row.id)).size).toBe(5);
}, 120_000);

test('hidden leading members and late disclosure changes never become complete empty or stale previews', async () => {
  const collection = await f.collection('public');
  const hidden = await f.createSubject('game', 'Hidden preview prefix');
  const subjects = [
    await f.createSubject('game', 'Current preview A'),
    await f.createSubject('recipe', 'Current preview B'),
    await f.createSubject('record', 'Current preview C'),
  ];
  await f.populate(collection.id, [hidden, ...subjects]);
  await f.hide(hidden);
  for (const bearer of [f.previewOwner.bearer, f.previewOther.bearer, 'anonymous']) {
    expectReadyPreview(
      (await f.page(bearer)).collections.find((row) => row.id === collection.id),
      subjects,
    );
  }
  await f.hide(subjects[0]!);
  for (const bearer of [f.previewOwner.bearer, f.previewOther.bearer, 'anonymous']) {
    expectReadyPreview(
      (await f.page(bearer)).collections.find((row) => row.id === collection.id),
      subjects.slice(1),
    );
  }
}, 120_000);

test('private parent identities stay concealed from other accounts and anonymous lists', async () => {
  const collection = await f.collection();
  const subject = await f.createSubject('game', 'Private parent preview');
  await f.populate(collection.id, [subject]);
  expectReadyPreview(
    (await f.page()).collections.find((row) => row.id === collection.id),
    [subject],
  );
  for (const bearer of [f.previewOther.bearer, 'anonymous']) {
    const body = await f.page(bearer);
    expect(body.collections.some((row) => row.id === collection.id)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(collection.id);
  }
}, 120_000);

test('a pre-suspension bearer cannot request retained or direct previews', async () => {
  const reader = await f.identity(['subject:read', 'collection:read']);
  const collection = await f.collection('public');
  expect((await f.list(reader.bearer)).status).toBe(200);
  await f.suspend(reader.actor.accountId);
  const response = await f.list(reader.bearer);
  expect(response.status).toBe(401);
  expect((await response.json()).code).toBe('invalid_credentials');
  expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect((await f.page('anonymous')).collections.some((row) => row.id === collection.id)).toBe(true);
}, 120_000);

test('twenty selected Collections share one native member prefix batch and a global hundred-row bound', async () => {
  const subjects = [
    await f.createSubject('game', 'Batch preview A'),
    await f.createSubject('recipe', 'Batch preview B'),
    await f.createSubject('record', 'Batch preview C'),
  ];
  const selected: string[] = [];
  for (let n = 0; n < 20; n++) {
    const collection = await f.collection();
    selected.push(collection.id);
    await f.populate(collection.id, subjects);
  }
  let collecting = false;
  const prefixes: { sql: string; rows: number; bytes: number }[] = [];
  await observeRetentionQueries(f.pool, ({ sql, result }) => {
    if (collecting && /\blibrary\.collection_member\b/i.test(sql) && /^\s*(?:WITH|SELECT)\b/i.test(sql))
      prefixes.push({ sql, rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
  });
  collecting = true;
  let page: Awaited<ReturnType<typeof f.page>>;
  try {
    page = await f.page();
  } finally {
    collecting = false;
  }
  expect(page.collections).toHaveLength(20);
  expect(new Set(page.collections.map((row) => row.id))).toEqual(new Set(selected));
  for (const row of page.collections) expectReadyPreview(row, subjects);
  expect(prefixes).toHaveLength(1);
  expect(prefixes[0]!.sql).toMatch(/\bLATERAL\b/i);
  expect(prefixes.reduce((sum, query) => sum + query.rows, 0)).toBeLessThanOrEqual(100);
  expect(prefixes[0]!.bytes).toBeGreaterThan(0);
}, 120_000);

test('changing a public parent to private withdraws its preview on the next other-account and anonymous list', async () => {
  const collection = await f.collection('public');
  const subject = await f.createSubject('game', 'Withdrawn parent preview');
  await f.populate(collection.id, [subject]);
  for (const bearer of [f.previewOther.bearer, 'anonymous'])
    expectReadyPreview(
      (await f.page(bearer)).collections.find((row) => row.id === collection.id),
      [subject],
    );
  const current = await f.send(f.previewOwner.bearer, 'GET', `/v1/collections/${collection.id}`);
  expect(current.status).toBe(200);
  const { revision } = ((await current.json()) as { collection: { revision: number } }).collection;
  const changed = await f.send(f.previewOwner.bearer, 'PATCH', `/v1/collections/${collection.id}`, {
    revision,
    visibility: 'private',
  });
  expect(changed.status).toBe(200);
  for (const bearer of [f.previewOther.bearer, 'anonymous'])
    expect((await f.page(bearer)).collections.some((row) => row.id === collection.id)).toBe(false);
  expectReadyPreview(
    (await f.page()).collections.find((row) => row.id === collection.id),
    [subject],
  );
}, 120_000);

test('a completely observed hidden-only population is ready empty and leaks no occurrence annotation', async () => {
  const collection = await f.collection('public');
  const hidden = await f.createSubject('game', 'Excluded-only preview');
  await f.populate(collection.id, [hidden, hidden]);
  await f.hide(hidden);
  for (const bearer of [f.previewOwner.bearer, f.previewOther.bearer, 'anonymous']) {
    const row = (await f.page(bearer)).collections.find((candidate) => candidate.id === collection.id);
    expectReadyPreview(row, []);
    expect(JSON.stringify(row)).not.toContain(hidden);
    expect(JSON.stringify(row)).not.toContain('Private occurrence annotation');
  }
}, 120_000);
