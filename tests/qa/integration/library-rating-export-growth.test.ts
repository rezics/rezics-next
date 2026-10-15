import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryBundleExporter, LIBRARY_EXPORT_COST } from '../../../services/main/src/modules/library-export/bundle.ts';
import { LibraryFileStore, importDigest } from '../../../services/main/src/modules/library-import/file-store.ts';
import { emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { startHomeStack } from './feed-read-support.ts';
import { pollLibraryImportApply } from './library-import-apply-support.ts';

type Page = { rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
type Plan = { 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Rows Removed by Filter'?: number; Plans?: Plan[] };
const examined = (plan: Plan): number => (plan['Relation Name']
  ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops'] : 0)
  + (plan.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);

type ExportSample = { size: number; sql: number; sqlRows: number; graph: number; ms: number };
function meteredPool<T extends Pool | PoolClient>(pool: T, sample: () => ExportSample | undefined): T {
  return new Proxy(pool, { get(owner, key) {
      if (key === 'connect' && !('release' in owner)) return async () => meteredPool(await owner.connect(), sample);
      if (key === 'query') return async (text: string, values?: unknown[]) => {
        const result = await owner.query(text, values);
        const active = sample();
        if (active) {
          active.sql++;
          if (/^\s*(?:SELECT|WITH)\b/i.test(text) && /\b(?:reader|access|content)\./.test(text)) {
            const explained = await owner.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
            active.sqlRows += examined(explained.rows[0]['QUERY PLAN'][0].Plan as Plan);
          }
        }
        return result;
      };
      const value: unknown = Reflect.get(owner, key, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    } });
}

test('rating export pages seek a fixed batch and the exported score re-imports for another reader', async () => {
  const home = await startHomeStack('rating-export-growth');
  const samples: ExportSample[] = [];
  let active: typeof samples[number] | undefined;
  try {
    const { stack } = home;
    const agent = await home.provision('Rating growth reader', home.reader.token);
    const other = await home.provision('Rating copy reader', home.author.token);
    for (const token of [home.reader.token, home.author.token]) {
      const login = await home.deps.account.verify(new Request('http://main.local/login', { headers: { authorization: `Bearer ${token}` } }));
      const principal = await login.currentAssertion?.();
      if (!principal) throw new Error('Reader has no login principal');
      Object.assign(principal, { accountScopes: ['work:read', 'library:write'] });
    }
    const grant = (scope: string, action: string, actor = agent, principalId = home.reader.principalId) =>
      grantFixtureAuthority(stack.accessPool, { scope, requireDispatch: true,
        representations: [{ principalId, actor, action, lifetime: '8 hours' }],
        grant: { actor, action, lifetime: '8 hours' } });
    const wrap = <T extends Pool | PoolClient>(pool: T) => meteredPool(pool, () => active);
    const app = createMainApp(stack.fuseki, { ...home.deps,
      libraryBundle: new LibraryBundleExporter(wrap(stack.contentPool), wrap(stack.accessPool)) });
    home.deps.libraryImport!.setDispatch(request => app.handle(request));
    const call = (method: string, path: string, body?: object, token = home.reader.token) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    await grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const { context } = await home.json<{ context: string }>(await call('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Reading quality', actingSubject: agent }), 201);
    await grant(`rating:observe:${context}`, 'rating.observation.set');
    await grant(`rating:observe:${context}`, 'rating.observation.set', other, home.author.principalId);
    const exportPage = async (cursor?: string | null, snapshot?: string) => home.json<Page>(await call('GET',
      `/v1/me/library-export?${new URLSearchParams({ actingSubject: agent, limit: '2',
        ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) })}`));
    let previous = 0;
    let first: Page | undefined;
    for (const size of [4, 8, 16]) {
      for (let i = previous; i < size; i++) {
        const work = await stack.publicWork(agent, ['en'], `Rating inventory ${i}`);
        await home.json(await call('POST', '/v1/global-rating-observations', {
          profile: 'global-rating-standing-observation-v1', context, work: work.work, mainVersion: work.mainVersion,
          expectedRevisionHead: null, value: 4, actingSubject: agent }), 201);
      }
      await stack.accessPool.query('ANALYZE access.rating_aggregate_head');
      const sample = { size, sql: 0, sqlRows: 0, graph: 0, ms: 0 };
      const beforeGraph = stack.fuseki.queries;
      active = sample;
      const start = performance.now();
      try { first = await exportPage(); } finally { active = undefined; sample.ms = performance.now() - start; sample.graph = stack.fuseki.queries - beforeGraph; }
      samples.push(sample);
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).toBeString();
      previous = size;
    }
    console.table(samples);
    for (const sample of samples) {
      expect(sample.sql).toBe(samples[0]!.sql);
      expect(sample.sql).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.sqlPerPage);
      expect(sample.graph).toBe(samples[0]!.graph);
      expect(sample.sqlRows, JSON.stringify(sample)).toBeLessThanOrEqual(samples[0]!.sqlRows);
    }
    const all = [...first!.rows];
    let cursor = first!.nextCursor;
    while (cursor) {
      const page = await exportPage(cursor, first!.snapshot);
      all.push(...page.rows); cursor = page.nextCursor;
    }
    expect(all.filter(row => row.sourceId.startsWith('rating:'))).toHaveLength(16);
    const rating = all.find(row => row.kind === 'entry' && row.score)!;
    expect(rating).toMatchObject({ score: { min: 1, max: 5, step: 1, value: 4 } });
    const file = await home.json<{ id: string }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: other, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: [rating] }) }, home.author.token), 201);
    const reviewed = await home.json(await call('GET', `/v1/me/library-imports/${file.id}/rows?actingSubject=${encodeURIComponent(other)}`, undefined, home.author.token));
    const progress = await pollLibraryImportApply(() => call('GET', `/v1/me/library-imports/${file.id}/apply?actingSubject=${encodeURIComponent(other)}`, undefined, home.author.token), {
      started: call('POST', `/v1/me/library-imports/${file.id}/apply`, { actingSubject: other, context, language: 'en' }, home.author.token) });
    expect(progress).toMatchObject({ completed: 1, issues: 0, pending: false });
    const copied = await stack.accessPool.query('SELECT work FROM access.rating_aggregate_head WHERE principal_id=$1', [home.author.principalId]);
    expect(copied.rows, JSON.stringify({ rating, reviewed, progress })).toEqual([{ work: rating.work }]);
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/rating-export.json`, JSON.stringify(samples, null, 2) + '\n');
    await home.stop();
  }
}, 300_000);


test('retained source export examines one batch as the uploaded library grows', async () => {
  const home = await startHomeStack('source-export-growth');
  const samples: ExportSample[] = [];
  let active: ExportSample | undefined;
  try {
    const { stack } = home;
    const agent = await home.provision('Source export reader', home.reader.token);
    const login = await home.deps.account.verify(new Request('http://main.local/login', {
      headers: { authorization: `Bearer ${home.reader.token}` } }));
    const principal = await login.currentAssertion?.();
    if (!principal) throw new Error('Reader has no login principal');
    Object.assign(principal, { accountScopes: ['work:read', 'library:write'] });
    const app = createMainApp(stack.fuseki, { ...home.deps, libraryBundle: new LibraryBundleExporter(
      meteredPool(stack.contentPool, () => active), meteredPool(stack.accessPool, () => active)) });
    const files = new LibraryFileStore(stack.contentPool);
    let previousFile: string | undefined;
    for (const size of [32, 128, 512]) {
      if (previousFile) await files.delete(agent, previousFile, `delete:${size}`);
      const sources = Array.from({ length: size }, (_, index) => ({
        ...emptyRow(`source:${index}`, '', {}), kind: 'retained' as const }));
      const file = await files.create(agent, `source:${size}`, importDigest(sources), 'rezics', sources);
      previousFile = file.id;
      await stack.contentPool.query('ANALYZE reader.library_import_source');
      await stack.contentPool.query('ANALYZE reader.library_import_source_row');
      const sample = { size, sql: 0, sqlRows: 0, graph: 0, ms: 0 };
      const beforeGraph = stack.fuseki.queries, start = performance.now();
      active = sample;
      let page: Page;
      try { page = await home.json<Page>(await app.handle(new Request(
        `http://main.local/v1/me/library-export?${new URLSearchParams({ actingSubject: agent, limit: '2' })}`,
        { headers: { authorization: `Bearer ${home.reader.token}` } }))); }
      finally { active = undefined; sample.ms = performance.now() - start; sample.graph = stack.fuseki.queries - beforeGraph; }
      samples.push(sample);
      expect(page.rows).toHaveLength(2);
      expect(page.nextCursor).toBeString();
    }
    console.table(samples);
    for (const sample of samples) {
      expect(sample.sql).toBe(samples[0]!.sql);
      expect(sample.sql).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.sqlPerPage);
      expect(sample.graph).toBe(samples[0]!.graph);
      expect(sample.sqlRows, JSON.stringify(sample)).toBeLessThanOrEqual(samples[0]!.sqlRows);
    }
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/source-export.json`, JSON.stringify(samples, null, 2) + '\n');
    await home.stop();
  }
}, 300_000);
