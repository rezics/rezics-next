import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { chooseLabel, languageRanges } from '../../src/semantic/language.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { readSubjectSummaries } from '../../src/semantic/summaries.ts';
import { expandSlot } from '../../src/semantic/slots.ts';
import { createRealAccess } from './real-access.ts';

const chain = 'zh-Hans, zh;q=0.9, zh-Hant;q=0.8, en;q=0.5';
const labels = { 'zh-Hant': '繁體標題', en: 'English title' };

test("label choice walks the reader's whole language list in quality order", () => {
  expect(languageRanges('en;q=0.5, ja;q=1, fr;q=0.9, de;q=0.9')).toEqual(['ja', 'fr', 'de', 'en']);
  expect(languageRanges('en;q=0, *, ja;q=.8, fr;q=1.1, de;q=0.1234, bad_tag, ko;foo=1, es;q=oops, zh')).toEqual(['zh']);
  expect(languageRanges('en;q=0., ja;q=1.000, fr;q=0.001')).toEqual(['ja', 'fr']);
  expect(languageRanges(' EN ; Q=0.8, ja\t;\tq=0.8 ', 'ko')).toEqual(['ko', 'EN', 'ja']);
  expect(languageRanges('en, ja', 'bad_tag')).toEqual(['en', 'ja']);
  expect(languageRanges(null)).toEqual([]);
  const many = Array.from({ length: 20 }, (_, i) => `en-x-${i}`).join(',');
  expect(languageRanges(many)).toHaveLength(16);
  expect(languageRanges(many, 'ja')).toEqual(['ja', ...languageRanges(many).slice(0, 15)]);
  expect(chooseLabel(labels, languageRanges(chain))).toEqual({ value: '繁體標題', language: 'zh-Hant' });
  expect(chooseLabel(labels, languageRanges('en;q=0.5, zh-Hant;q=0.9'))).toEqual({
    value: '繁體標題',
    language: 'zh-Hant',
  });
  expect(chooseLabel(labels, languageRanges(chain, 'en'))).toEqual({ value: 'English title', language: 'en' });
});

test("a regional tag finds its script's label", () => {
  const scripts = { 'zh-Hans': '简体', 'zh-Hant': '繁體', en: 'English' };
  expect(chooseLabel(scripts, ['zh-CN'])).toEqual({ value: '简体', language: 'zh-Hans' });
  expect(chooseLabel(scripts, ['zh-TW'])).toEqual({ value: '繁體', language: 'zh-Hant' });
  expect(chooseLabel({ 'de-Latn': 'Deutsch', en: 'English' }, ['de-Latn-DE-1996'])).toEqual({
    value: 'Deutsch',
    language: 'de-Latn',
  });
  expect(chooseLabel({ 'JA-jp': '日本語', ja: 'Japanese' }, ['ja-JP-x-private'])).toEqual({
    value: '日本語',
    language: 'JA-jp',
  });
  expect(chooseLabel({ en: 'English', 'en-x': 'Invalid singleton' }, ['en-x-private'])).toEqual({
    value: 'English',
    language: 'en',
  });
  expect(chooseLabel({ 'i-klingon': 'Klingon' }, ['i-klingon'])).toEqual({ value: 'Klingon', language: 'i-klingon' });
});

test("a label falls back to the subject's original language, then English, then the first", () => {
  expect(chooseLabel({ ja: '日本語', en: 'English' }, ['ko'], 'ja')).toEqual({ value: '日本語', language: 'ja' });
  expect(chooseLabel(labels, ['ko'], 'ZH-tw')).toEqual({ value: '繁體標題', language: 'zh-Hant' });
  expect(chooseLabel({ ja: '日本語', en: 'English' }, ['ko'], 'fr')).toEqual({ value: 'English', language: 'en' });
  expect(chooseLabel({ ja: '日本語', de: 'Deutsch' }, ['ko'], 'fr')).toEqual({ value: 'Deutsch', language: 'de' });
  expect(chooseLabel({ ja: '日本語', en: 'English' }, ['en'], 'ja')).toEqual({ value: 'English', language: 'en' });
  expect(chooseLabel({ en: '' }, [])).toEqual({ value: '', language: 'en' });
  expect(chooseLabel({}, ['ja'], 'ja')).toBeNull();
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const access = await createRealAccess(admin, { editor: newId(32000) }, ['subject:create', 'subject:read']);
const kernel = createKernel({
  pool,
  requestDeadlineMs: 30_000,
  access: access.access,
  writeRate: access.writeRate,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(76)]]) },
  routeKey: new Uint8Array(32).fill(77),
});
const projection = linkProjection(pool);
const subjects: string[] = [];
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function call(path: string, language = chain, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        'accept-language': language,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(body === undefined ? 200 : 201);
  return result as any;
}
async function create(type: string, title: Record<string, string>, statements = {}) {
  const result = await call('/v1/subjects', chain, { type, labels: title, statements });
  subjects.push(result.subject.id);
  return result.subject.id as string;
}
async function catchUp() {
  for (const partition of new Set(subjects.map((id) => partitionOf(routeOf(id)!)))) {
    for (let step = 0; step < 100; step++) {
      const result = await projection.run(partition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 99) throw new Error('Link projection did not catch up');
    }
  }
}
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test("every semantic read that embeds a chosen label uses the reader's whole list", async () => {
  const person = await create('schema:Person', labels);
  const book = await create('schema:Book', labels, { 'schema:author': [statement('schema:author', person)] });
  await catchUp();
  const inverse = await call(`/v1/subjects/${person}/links?property=schema%3Aauthor`);
  expect(inverse.links.map((link: any) => [link.subject, link.label, link.summary.label])).toEqual([
    [book, '繁體標題', { value: '繁體標題', language: 'zh-Hant' }],
  ]);
  const forward = await call(`/v1/subjects/${book}/relations?property=schema%3Aauthor`);
  expect(forward.relations.map((relation: any) => [relation.target, relation.label])).toEqual([[person, '繁體標題']]);
  const preview = await call(`/v1/subjects/${book}`);
  expect(preview.summary.label).toEqual({ value: '繁體標題', language: 'zh-Hant' });
  expect(preview.subject.statements['schema:author'][0].value.content).toBe(person);
  expect(preview.related[person].labels).toEqual(labels);
  const summaries = await readSubjectSummaries(
    {
      routeKey: new Uint8Array(32).fill(77),
      pool,
      access: kernelAccess(),
      actor: { kind: 'anonymous' },
      deadline: Date.now() + 30_000,
    },
    [book],
    { languages: languageRanges(chain) },
  );
  expect(summaries.get(book)?.label).toEqual({ value: '繁體標題', language: 'zh-Hant' });
  for (const path of [
    `/v1/subjects/${book}`,
    `/v1/subjects/${person}/links?property=schema%3Aauthor`,
    `/v1/subjects/${book}/relations?property=schema%3Aauthor`,
  ]) {
    const result = await call(path, 'en;q=0.1, zh-Hant;q=0.9');
    expect(result.summary?.label.value ?? result.links?.[0].label ?? result.relations?.[0].label).toBe('繁體標題');
    const overridden = await call(`${path}${path.includes('?') ? '&' : '?'}language=EN`);
    expect(overridden.summary?.label.value ?? overridden.links?.[0].label ?? overridden.relations?.[0].label).toBe(
      'English title',
    );
    const unmatchedOverride = await call(`${path}${path.includes('?') ? '&' : '?'}language=ko`);
    expect(
      unmatchedOverride.summary?.label.value ??
        unmatchedOverride.links?.[0].label ??
        unmatchedOverride.relations?.[0].label,
    ).toBe('繁體標題');
  }
});

// Use the same real Access policy for the batched read as the HTTP routes.
function kernelAccess() {
  return access.access({ actions: new Map([['subject:read', { anonymous: true }]]) });
}

test('an unmatched reader gets the original Japanese label in pages, previews and summaries', async () => {
  const person = await create('schema:Person', labels);
  const book = await create(
    'schema:Book',
    { ja: '日本語の題名', en: 'English title' },
    {
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
      'schema:author': [statement('schema:author', person)],
    },
  );
  const edition = await create(
    'bf:Instance',
    { en: 'Edition' },
    {
      'schema:exampleOfWork': [statement('schema:exampleOfWork', book)],
    },
  );
  await catchUp();
  const forward = await call(`/v1/subjects/${edition}/relations?property=schema%3AexampleOfWork`, 'ko');
  expect(forward.relations[0].label).toBe('日本語の題名');
  const inverse = await call(`/v1/subjects/${person}/links?property=schema%3Aauthor`, 'ko');
  expect(inverse.links[0].label).toBe('日本語の題名');
  expect(inverse.links[0].summary.label).toEqual({ value: '日本語の題名', language: 'ja' });
  expect((await call(`/v1/subjects/${book}`, 'ko')).summary.label).toEqual({ value: '日本語の題名', language: 'ja' });
  const summaries = await readSubjectSummaries(
    {
      routeKey: new Uint8Array(32).fill(77),
      pool,
      access: kernelAccess(),
      actor: { kind: 'anonymous' },
      deadline: Date.now() + 30_000,
    },
    [book],
    { languages: languageRanges('ko') },
  );
  expect(summaries.get(book)?.label).toEqual({ value: '日本語の題名', language: 'ja' });
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const revision = await client.query(
      'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
      [routeOf(book), book],
    );
    await expandSlot(client, book, 'schema:inLanguage', revision.rows[0].recorded_transaction_id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect((await call(`/v1/subjects/${book}`, 'ko')).summary.label).toEqual({ value: '日本語の題名', language: 'ja' });
  expect(
    (await call(`/v1/subjects/${edition}/relations?property=schema%3AexampleOfWork`, 'ko')).relations[0].label,
  ).toBe('日本語の題名');
});
