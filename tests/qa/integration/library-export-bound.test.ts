import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LIBRARY_EXPORT_COST, retainedLibrarySourcePageSql } from '../../../services/main/src/modules/library-export/bundle.ts';
import { emptyRow, type CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';

const SOURCES = 1_200;
const EXPORTABLE = SOURCES / 20;
type ExportPage = { profile: 'rezics-library-export-v1'; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
interface Plan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}

function examined(node: Plan): number {
  return (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0))
    * node['Actual Loops'];
}

function planOf(result: { rows: Array<Record<string, unknown>> }): Plan {
  const plan = (result.rows[0]?.['QUERY PLAN'] as Array<{ Plan: Plan }> | undefined)?.[0]?.Plan;
  if (!plan) throw new Error('Export inventory query has no plan');
  return plan;
}

/** Sources the exportable index actually touched, including any it discarded. */
function sourcesExamined(plan: Plan): number {
  let seen = false;
  let worst = 0;
  const visit = (node: Plan) => {
    if (node['Index Name'] === 'library_import_source_exportable' || node['Relation Name'] === 'library_import_source') {
      seen = true;
      worst = Math.max(worst, examined(node));
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  if (!seen) throw new Error(`Export page did not seek library_import_source: ${JSON.stringify(plan)}`);
  return worst;
}

test('a library export page seeks only exportable sources when most of the library is not', async () => {
  const home = await startHomeStack('library-export-bound');
  try {
    const login = await home.deps.account.verify(new Request('http://main.local/login', {
      headers: { authorization: `Bearer ${home.reader.token}` } }));
    const stored = await login.currentAssertion?.();
    if (!stored) throw new Error('Library reader has no login principal');
    const agent = await home.provision('Library export bound', home.reader.token);
    Object.assign(stored, { accountScopes: ['work:read', 'library:write'] });
    const retained: CanonicalRow[] = [];
    const rows = Array.from({ length: SOURCES }, (_, index) => {
      const exportable = index % 20 === 0;
      const source = emptyRow(exportable ? `kept-${index}` : `plain-${index}`, `Title ${index}`, {});
      if (exportable) {
        source.kind = 'retained';
        retained.push(source);
      } else source.kind = 'entry';
      return source;
    });
    expect(retained).toHaveLength(EXPORTABLE);
    const call = (method: string, path: string, body?: object) => home.app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${home.reader.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const uploaded = await home.json<{ id: string; total: number }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows }) }), 201);
    expect(uploaded.total).toBe(SOURCES);
    // A clean outcome clears archive_needed. Entries with empty extras then leave
    // the exportable index; retained sources stay on it.
    await home.stack.contentPool.query(`UPDATE reader.library_import_source_row r
      SET outcome='{"applied":[],"issues":[]}'::jsonb, resolution='{"choice":"apply"}'::jsonb
      FROM reader.library_import_source s
      WHERE r.agent=s.agent AND r.source_digest=s.digest AND r.agent=$1 AND s.source->>'kind'<>'retained'`, [agent]);
    const counts = await home.stack.contentPool.query<{ exportable: number; hidden: number }>(
      `SELECT count(*) FILTER (WHERE exportable)::integer AS exportable,
        count(*) FILTER (WHERE NOT exportable)::integer AS hidden
        FROM reader.library_import_source WHERE agent=$1`, [agent]);
    expect(counts.rows[0]).toEqual({ exportable: EXPORTABLE, hidden: SOURCES - EXPORTABLE });
    await home.stack.contentPool.query('ANALYZE reader.library_import_source');
    await home.stack.contentPool.query('ANALYZE reader.library_import_source_row');
    await home.stack.contentPool.query('ANALYZE reader.library_import_file');
    const limit = LIBRARY_EXPORT_COST.page + 1;
    const assertPage = async (after: string) => {
      const explained = await home.stack.contentPool.query(
        'EXPLAIN (ANALYZE, FORMAT JSON) ' + retainedLibrarySourcePageSql, [agent, after, limit]);
      const plan = planOf(explained);
      expect(sourcesExamined(plan), JSON.stringify(plan)).toBeLessThanOrEqual(limit);
      expect(JSON.stringify(plan)).toContain('library_import_source_exportable');
    };
    await assertPage('');
    const resumedAt = await home.stack.contentPool.query<{ digest: string }>(
      `SELECT digest FROM reader.library_import_source WHERE agent=$1 AND exportable ORDER BY digest OFFSET $2 LIMIT 1`,
      [agent, EXPORTABLE / 2]);
    await assertPage(resumedAt.rows[0]!.digest);
    const original = home.stack.contentPool.query.bind(home.stack.contentPool);
    const pageSizes: number[] = [];
    home.stack.contentPool.query = ((...args: unknown[]) => {
      if (args.some(arg => typeof arg === 'function')) return original(...args);
      const sql = typeof args[0] === 'string' ? args[0] : '';
      return original(...args).then((result: { rowCount: number | null; rows: unknown[] }) => {
        if (/FROM\s+reader\.library_import_source\b/.test(sql) && /\bLIMIT\b/i.test(sql) && /^\s*SELECT\b/i.test(sql)) {
          pageSizes.push(result.rowCount ?? result.rows.length);
        }
        return result;
      });
    }) as typeof home.stack.contentPool.query;

    const exported: CanonicalRow[] = [];
    let cursor: string | null = null;
    let snapshot: string | undefined;
    do {
      const query = new URLSearchParams({ actingSubject: agent, ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) });
      const page = await home.json<ExportPage>(await call('GET', `/v1/me/library-export?${query}`));
      expect(page.rows.length).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.page);
      exported.push(...page.rows);
      snapshot = page.snapshot;
      cursor = page.nextCursor;
    } while (cursor);
    const sourceIds = exported.map(row => row.sourceId);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(new Set(sourceIds)).toEqual(new Set(retained.map(row => row.sourceId)));
    expect(exported.filter(row => row.kind === 'retained')).toHaveLength(EXPORTABLE);
    expect(pageSizes.length).toBeGreaterThan(0);
    for (const size of pageSizes) expect(size).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.page + 1);
    home.stack.contentPool.query = original;
  } finally {
    await home.stop();
  }
}, 300_000);
