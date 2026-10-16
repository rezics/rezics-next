import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore, type StoredSourceRow } from '../../../services/main/src/modules/library-import/file-store.ts';
import { FILE_IMPORT_COST, emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';
import { foregroundCounted } from './support/query-cost-meter.ts';

interface Plan {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}
function examined(plan: Plan): number {
  const here = plan['Relation Name'] ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
    + (plan['Rows Removed by Index Recheck'] ?? 0)) * plan['Actual Loops'] : 0;
  return here + (plan.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
}

test('first and middle import pages keep matching, authority checks and visited rows bounded at 16 and 1024 source rows', async () => {
  const home = await startHomeStack('library-import-page-growth');
  try {
    const { stack } = home;
    const agent = await home.provision('Import page reader', home.reader.token);
    const book = await stack.publicWork(agent, ['en'], 'Import page book');
    const principal = await home.deps.account.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${home.reader.token}` } }));
    const stored = await principal.currentAssertion?.();
    if (!stored || !home.deps.libraryImport) throw new Error('Library import fixture is not wired');
    Object.assign(stored, { accountScopes: ['work:read', 'library:write'] });
    let measuring = false, statements = 0, matching = 0, writeChecks = 0, returnedRows = 0;
    const seeks: Array<{ sql: string; values: unknown[] }> = [];
    const pool = new Proxy(stack.contentPool, { get(target, key) {
      if (key === 'query') return async (sql: string, values: unknown[]) => {
        const counted = measuring && foregroundCounted();
        const result = await target.query(sql, values);
        if (counted) {
          statements++;
          if (/^\s*SELECT\b/.test(sql)) returnedRows += result.rows.length;
          if (/FROM reader\.library_import_source_row r/.test(sql)) seeks.push({ sql, values });
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    const files = new LibraryFileStore(pool);
    const imports = home.deps.libraryImport;
    const app = createMainApp(stack.fuseki, { ...home.deps, libraryFiles: files,
      account: { verify: async (request, scopes) => {
        if (measuring && scopes?.includes('library:write')) writeChecks++;
        return home.deps.account.verify(request);
      } } });
    imports.setDispatch(request => {
      if (measuring) matching++;
      return app.handle(request);
    });
    const call = (method: string, path: string, body?: object, token = home.reader.token) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const costs: Array<{ size: number; cursor: number; statements: number; matching: number; writeChecks: number;
      returnedRows: number; visited: number }> = [];
    // The small reader page must seek beside other people's uploads too.
    // Avoid proving a plan that only works when the entire database is tiny.
    const other = await home.provision('Unrelated import reader', home.author.token);
    await home.json(await call('POST', '/v1/me/library-imports', {
      actingSubject: other, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1',
        rows: Array.from({ length: 1024 }, (_, index) => emptyRow(`unrelated:${index}`, 'Unrelated book', {})) }),
    }, home.author.token), 201);
    for (const size of [16, 1024]) {
      const rows = Array.from({ length: size }, (_, index) => ({
        ...emptyRow(`${size}:${index}`, 'Import page book', {}), work: book.work,
      }));
      const uploaded = await home.json<{ id: string; total: number }>(await call('POST', '/v1/me/library-imports', {
        actingSubject: agent, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows }),
      }), 201);
      expect(uploaded.total).toBe(size);
      for (const table of ['library_import_file', 'library_import_source_row', 'library_import_source']) {
        await stack.contentPool.query(`ANALYZE reader.${table}`);
      }
      for (const cursor of [-1, size / 2 - 1]) {
        statements = matching = writeChecks = returnedRows = 0;
        seeks.length = 0;
        measuring = true;
        const response = await call('GET', `/v1/me/library-imports/${uploaded.id}/rows?`
          + new URLSearchParams({ actingSubject: agent, cursor: String(cursor) }));
        measuring = false;
        const page = await home.json<{ rows: StoredSourceRow[]; nextCursor: number | null }>(response);
        expect(page.rows.map(row => row.index)).toEqual(Array.from({ length: FILE_IMPORT_COST.page }, (_, i) => cursor + i + 1));
        expect(page.rows.every(row => row.match?.kind === 'matched' && row.match.work === book.work && row.version === 2)).toBe(true);
        expect(page.nextCursor).toBe(cursor + FILE_IMPORT_COST.page < size - 1 ? cursor + FILE_IMPORT_COST.page : null);
        expect(seeks).toHaveLength(2);
        let visited = 0;
        for (const seek of seeks) {
          const result = await stack.contentPool.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + seek.sql, seek.values);
          const plan = result.rows[0]?.['QUERY PLAN']?.[0]?.Plan as Plan | undefined;
          if (!plan) throw new Error('Import page seek has no execution plan');
          visited += examined(plan);
        }
        const cost = { size, cursor, statements, matching, writeChecks, returnedRows, visited };
        costs.push(cost);
        expect(cost).toMatchObject({ statements: 12, matching: FILE_IMPORT_COST.page, writeChecks: FILE_IMPORT_COST.page });
        expect(returnedRows).toBeLessThanOrEqual(2 * (FILE_IMPORT_COST.page + 2));
        expect(visited).toBeLessThanOrEqual(8 * FILE_IMPORT_COST.page);
      }
    }
    console.log('LIBRARY_IMPORT_PAGE_GROWTH', JSON.stringify(costs));
    for (let page = 0; page < 2; page++) {
      expect(costs[page + 2]!.visited).toBeLessThanOrEqual(costs[page]!.visited + 2 * FILE_IMPORT_COST.page);
    }
  } finally { await home.stop(); }
}, 180_000);
