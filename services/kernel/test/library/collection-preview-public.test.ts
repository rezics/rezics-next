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

test('anonymous preview uses current public disclosure without writes or curator authority', async () => {
  const collection = await f.collection('public');
  const privateParent = await f.collection();
  const hidden = await f.createSubject('game', 'Hidden anonymous original');
  const visible = await f.createSubject('game', 'Visible anonymous original');
  await f.populate(collection.id, [hidden, visible]);
  await f.populate(privateParent.id, [visible]);
  await f.hide(hidden);
  const statements: string[] = [];
  let reading = false;
  await observeRetentionQueries(f.pool, ({ sql }) => {
    if (reading) statements.push(sql);
  });
  reading = true;
  let page: Awaited<ReturnType<typeof f.page>>;
  try {
    page = await f.page('anonymous');
  } finally {
    reading = false;
  }
  expectReadyPreview(
    page.collections.find((row) => row.id === collection.id),
    [visible],
  );
  expect(page.collections.some((row) => row.id === privateParent.id)).toBe(false);
  expect(JSON.stringify(page)).not.toContain(hidden);
  expect(JSON.stringify(page)).not.toContain('Private occurrence annotation');
  expect(statements.some((sql) => /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?\w+\.|DELETE\s+FROM)\b/i.test(sql))).toBe(
    false,
  );
  expect(statements.some((sql) => /\bcore\.(?:receipt|operational)|\bdbos\./i.test(sql))).toBe(false);
  await f.hide(visible);
  expectReadyPreview(
    (await f.page('anonymous')).collections.find((row) => row.id === collection.id),
    [],
  );
}, 120_000);

test('anonymous exhausted raw allowance is pending without a partial preview or retained preparation', async () => {
  const collection = await f.collection('public');
  const visible = await f.createSubject('game', 'First repeated preview member');
  const beyond = await f.createSubject('game', 'Beyond anonymous raw allowance');
  await f.populate(collection.id, [...Array<string>(100).fill(visible), beyond]);
  const rows: number[] = [];
  let reading = false;
  await observeRetentionQueries(f.pool, ({ sql, result }) => {
    if (reading && /\blibrary\.collection_member\b/i.test(sql)) rows.push(result.rows.length);
  });
  reading = true;
  let page: Awaited<ReturnType<typeof f.page>>;
  try {
    page = await f.page('anonymous');
  } finally {
    reading = false;
  }
  const row = page.collections.find((candidate) => candidate.id === collection.id)!;
  expect(row.previewStatus).toBe('pending');
  expect(row.previewMembers).toEqual([]);
  expect(rows).toHaveLength(1);
  expect(rows.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(100);
  expect(JSON.stringify(row)).not.toContain(beyond);
}, 120_000);

test('same-owner pending list preview remains read-only and does not reserve Members preparation', async () => {
  const collection = await f.collection();
  const visible = await f.createSubject('game', 'First repeated owner preview member');
  const beyond = await f.createSubject('game', 'Beyond owner preview allowance');
  await f.populate(collection.id, [...Array<string>(100).fill(visible), beyond]);
  const statements: string[] = [];
  let reading = false;
  await observeRetentionQueries(f.pool, ({ sql }) => {
    if (reading) statements.push(sql);
  });
  reading = true;
  let page: Awaited<ReturnType<typeof f.page>>;
  try {
    page = await f.page();
  } finally {
    reading = false;
  }
  const row = page.collections.find((candidate) => candidate.id === collection.id)!;
  expect(row.previewStatus).toBe('pending');
  expect(row.previewMembers).toEqual([]);
  expect(JSON.stringify(row)).not.toContain(beyond);
  expect(statements.some((sql) => /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?\w+\.|DELETE\s+FROM)\b/i.test(sql))).toBe(
    false,
  );
  expect(statements.some((sql) => /\bcore\.(?:receipt|operational)|\bdbos\./i.test(sql))).toBe(false);
  expect(statements.some((sql) => /library\.members_preparation/i.test(sql))).toBe(false);
}, 120_000);

test('a changed native source during summary projection returns typed unavailable', async () => {
  const collection = await f.collection('public');
  const subject = await f.createSubject('game', 'Preview source changes during projection');
  await f.populate(collection.id, [subject]);
  let reading = false;
  let changed = false;
  await observeRetentionQueries(f.pool, async ({ sql }) => {
    if (!reading || changed || !/\bsemantic\.subject\b/i.test(sql)) return;
    changed = true;
    await f.append(collection.id, subject);
  });
  reading = true;
  let response: Response;
  try {
    response = await f.list('anonymous');
  } finally {
    reading = false;
  }
  expect(changed).toBe(true);
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('dependency_unavailable');
}, 120_000);
