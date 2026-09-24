import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, pullFixtures, readLockedFixture } from '../../../scripts/fixtures/pull.ts';
import { wikidata, type FixtureSource, type WikidataFact } from '../../fixtures/sources/wikidata.ts';

const root = resolve(import.meta.dir, '../../..');
const raw = (revision: number, names = { en: 'Douglas Adams', ja: 'ダグラス・アダムズ', zh: '道格拉斯·亞當斯' }) => ({
  entities: { Q42: { id: 'Q42', lastrevid: revision,
    labels: Object.fromEntries(Object.entries(names).reverse().map(([language, value]) =>
      [language, { language, value }])),
    descriptions: { en: { language: 'en', value: 'discarded expressive description' } },
  } },
});
const response = (payload: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(payload), { status, headers });
const local = () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp', 'fixture-tests-'));
  mkdirSync(join(path, 'tests/fixtures'), { recursive: true });
  return path;
};
const adapter: FixtureSource = { ...wikidata, requests: wikidata.requests };

test('A locked real Wikidata fact replays offline with useful multilingual names', () => {
  const fact = readLockedFixture(root, 'wikidata', 'Q42') as WikidataFact;
  expect(fact.id).toBe('Q42');
  expect(fact.labels.map(label => label.language)).toEqual(['en', 'ja', 'zh']);
  expect(fact.labels.find(label => label.language === 'en')?.value).toBe('Douglas Adams');
  expect(fact.revision).toBeGreaterThan(0);
  expect(Object.keys(fact)).toEqual(['id', 'revision', 'labels']);
});

test('Normalization sorts selected facts and discards unrelated payload fields', () => {
  const a = wikidata.normalize(raw(7), 'Q42');
  const b = wikidata.normalize({ entities: { Q42: {
    id: 'Q42', labels: { en: { value: 'Douglas Adams', language: 'en' },
      zh: { value: '道格拉斯·亞當斯', language: 'zh' },
      ja: { value: 'ダグラス・アダムズ', language: 'ja' } }, lastrevid: 7,
    extra: 'ignored',
  } } }, 'Q42');
  expect(a).toEqual(b);
  expect(() => wikidata.normalize({ entities: {} }, 'Q42')).toThrow('Malformed');
});

test('Update-lock, offline hydration, cache integrity and explicit offline failure', async () => {
  const path = local();
  try {
    const fetched = await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true,
      fetcher: async () => response(raw(7)) as Response, now: () => new Date('2026-01-01T00:00:00Z') });
    expect(fetched[0]?.status).toBe('updated');
    const lock = JSON.parse(readFileSync(join(path, 'tests/fixtures/fixtures.lock.json'), 'utf8'));
    const entry = lock.entries[0];
    expect(entry.size).toBe(Buffer.byteLength(readFileSync(join(path, entry.seed))));
    expect(entry.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    rmSync(join(path, '.cache'), { recursive: true, force: true });
    const replay = await pullFixtures(path, { adapters: [adapter], offline: true,
      fetcher: async () => { throw new Error('network used'); } });
    expect(replay[0]?.status).toBe('hydrated');
    expect((readLockedFixture(path, 'wikidata', 'Q42') as WikidataFact).revision).toBe(7);
    writeFileSync(join(path, '.cache/fixtures/wikidata', `${entry.sha256}.json`), '{}');
    expect(() => readLockedFixture(path, 'wikidata', 'Q42')).toThrow('integrity mismatch');
    rmSync(join(path, '.cache'), { recursive: true, force: true });
    rmSync(join(path, entry.seed));
    await expect(pullFixtures(path, { adapters: [adapter], offline: true })).rejects.toThrow('unavailable offline');
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('Live drift is reported without rewriting lock, then accepted explicitly', async () => {
  const path = local();
  try {
    const fetcher = async () => response(raw(7)) as Response;
    await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true, fetcher });
    const before = readFileSync(join(path, 'tests/fixtures/fixtures.lock.json'), 'utf8');
    const changed = async () => response(raw(8)) as Response;
    const report = await pullFixtures(path, { adapters: [adapter], mode: 'live', fetcher: changed });
    expect(report[0]?.status).toBe('drift');
    expect(report[0]?.previousSha256).toBeDefined();
    expect(readFileSync(join(path, 'tests/fixtures/fixtures.lock.json'), 'utf8')).toBe(before);
    await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true, fetcher: changed });
    expect((readLockedFixture(path, 'wikidata', 'Q42') as WikidataFact).revision).toBe(8);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('Restoring an absent replay blob rejects upstream drift', async () => {
  const path = local();
  try {
    await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true,
      fetcher: async () => response(raw(7)) as Response });
    const entry = JSON.parse(readFileSync(join(path, 'tests/fixtures/fixtures.lock.json'), 'utf8')).entries[0];
    rmSync(join(path, '.cache'), { recursive: true, force: true });
    rmSync(join(path, entry.seed));
    await expect(pullFixtures(path, { adapters: [adapter],
      fetcher: async () => response(raw(8)) as Response })).rejects.toThrow('drifted');
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('An absent replay blob restores only bytes matching the lock', async () => {
  const path = local();
  try {
    await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true,
      fetcher: async () => response(raw(7)) as Response });
    const entry = JSON.parse(readFileSync(join(path, 'tests/fixtures/fixtures.lock.json'), 'utf8')).entries[0];
    rmSync(join(path, '.cache'), { recursive: true, force: true });
    rmSync(join(path, entry.seed));
    const restored = await pullFixtures(path, { adapters: [adapter],
      fetcher: async () => response(raw(7)) as Response });
    expect(restored[0]?.status).toBe('fetched');
    expect((readLockedFixture(path, 'wikidata', 'Q42') as WikidataFact).revision).toBe(7);
    entry.sha256 = 'bad';
    writeFileSync(join(path, 'tests/fixtures/fixtures.lock.json'),
      JSON.stringify({ version: 1, entries: [entry] }));
    expect(() => readLockedFixture(path, 'wikidata', 'Q42')).toThrow('Invalid fixture lock');
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('Fetch uses the source rate policy and identifying User-Agent', async () => {
  const path = local();
  try {
    const headers: string[] = [];
    const sleeps: number[] = [];
    let requests = 0;
    const result = await pullFixtures(path, { adapters: [adapter], mode: 'live', updateLock: true,
      fetcher: async (_url, init) => {
        headers.push(new Headers(init?.headers).get('user-agent') ?? '');
        return ++requests === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : response(raw(7));
      }, sleep: async ms => { sleeps.push(ms); } });
    expect(result[0]?.status).toBe('updated');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('REZICSFixtureHarness/1.0');
    expect(sleeps).toEqual([2000]);
    expect(parseArgs(['--source', 'wikidata', '--update-lock'])).toEqual({ source: 'wikidata', updateLock: true });
    expect(() => parseArgs(['--source', '../bad'])).toThrow();
  } finally { rmSync(path, { recursive: true, force: true }); }
});
