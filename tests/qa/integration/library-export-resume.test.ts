import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LIBRARY_EXPORT_COST, retainedLibrarySourcePageSql } from '../../../services/main/src/modules/library-export/bundle.ts';
import { emptyRow, type CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { getLibraryImportApplyWorker } from '../../../services/main/src/modules/library-import/apply-worker.ts';
import { startHomeStack } from './feed-read-support.ts';
import { pollLibraryImportApply } from './library-import-apply-support.ts';
import { isForegroundOperation } from './support/operation-cost.ts';

const RECORDS = 1_200;
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
const INVENTORY = /FROM\s+reader\.(consumption_session|library_status|private_import_review|library_import_source|library_copy|library_loan)\b/i;

/** Rows a scan actually touched, including those a filter discarded. */
function examined(node: Plan): number {
  return (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0))
    * node['Actual Loops'];
}

function assertSeek(plan: Plan) {
  const visit = (node: Plan) => {
    if (node['Relation Name'] || node['Index Name']) {
      expect(examined(node), JSON.stringify(node)).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.page + 1);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
}

function planOf(result: { rows: Array<Record<string, unknown>> }): Plan {
  const plan = (result.rows[0]?.['QUERY PLAN'] as Array<{ Plan: Plan }> | undefined)?.[0]?.Plan;
  if (!plan) throw new Error('Export inventory query has no plan');
  return plan;
}

function watchPool(pool: Pool) {
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  const plans: Plan[] = [];
  const returnedRows: number[] = [];
  let inventory = 0;
  pool.query = ((...args: unknown[]) => {
    if (args.some(arg => typeof arg === 'function')) return original(...args);
    const sql = typeof args[0] === 'string' ? args[0] : '';
    const values = Array.isArray(args[1]) ? args[1] : undefined;
    return original(...args).then(async result => {
      if (!isForegroundOperation() || !INVENTORY.test(sql) || !/^\s*SELECT\b/i.test(sql) || !/\bLIMIT\b/i.test(sql)) return result;
      inventory += 1;
      returnedRows.push(result.rowCount ?? result.rows.length);
      const explained = await original('EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, ...(values ? [values] : []));
      plans.push(planOf(explained));
      return result;
    });
  }) as Pool['query'];
  return {
    take() {
      const snapshot = { plans: plans.splice(0), returnedRows: returnedRows.splice(0), inventory };
      inventory = 0;
      return snapshot;
    },
    restore() { pool.query = original as Pool['query']; },
  };
}

test('a 1,200-record library export resumes after a dropped page and a new export repeats it', async () => {
  const home = await startHomeStack('library-export-resume');
  const files = home.deps.libraryFiles;
  const imports = home.deps.libraryImport;
  let restore = () => {};
  try {
    if (!files || !imports || !home.deps.libraryBundle) throw new Error('Library export is not wired');
    imports.setDispatch(request => home.app.handle(request));
    const login = await home.deps.account.verify(new Request('http://main.local/login', {
      headers: { authorization: `Bearer ${home.reader.token}` } }));
    const stored = await login.currentAssertion?.();
    if (!stored) throw new Error('Library reader has no login principal');
    const agent = await home.provision('Library export reader', home.reader.token);
    Object.assign(stored, { accountScopes: ['work:read', 'library:write'] });
    const retained = Array.from({ length: RECORDS }, (_, index) => {
      const row = emptyRow(`unmatched-${index}`, `Private title ${index}`, { progress: `c${index}`, extra: `private-${index}` });
      row.kind = 'retained';
      return row;
    });
    const call = (method: string, path: string, body?: object) => home.app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${home.reader.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const uploaded = await home.json<{ id: string; total: number }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: retained }) }), 201);
    expect(uploaded.total).toBe(RECORDS);
    for (let cursor: number | null = null; ;) {
      const query = new URLSearchParams({ actingSubject: agent, ...(cursor === null ? {} : { cursor: String(cursor) }) });
      const page = await home.json<{ nextCursor: number | null }>(await call('GET',
        `/v1/me/library-imports/${uploaded.id}/rows?${query}`));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const applied = await pollLibraryImportApply(
      () => call('GET', `/v1/me/library-imports/${uploaded.id}/apply?actingSubject=${encodeURIComponent(agent)}`),
      { started: call('POST', `/v1/me/library-imports/${uploaded.id}/apply`,
        { actingSubject: agent, context: null, language: 'en' }), deadlineMs: 360_000 });
    expect(applied).toMatchObject({ state: 'completed', pending: false, issues: 0, completed: RECORDS, total: RECORDS });
    await getLibraryImportApplyWorker(files, imports).stop();
    await home.stack.contentPool.query('ANALYZE reader.library_import_source');
    await home.stack.contentPool.query('ANALYZE reader.library_import_source_row');
    await home.stack.contentPool.query('ANALYZE reader.library_import_file');
    const seek = async (after: string) => {
      const explained = await home.stack.contentPool.query(
        'EXPLAIN (ANALYZE, FORMAT JSON) ' + retainedLibrarySourcePageSql, [agent, after, LIBRARY_EXPORT_COST.page + 1]);
      assertSeek(planOf(explained));
    };
    await seek('');
    const resumedAt = await home.stack.contentPool.query<{ digest: string }>(
      'SELECT digest FROM reader.library_import_source WHERE agent=$1 ORDER BY digest OFFSET 40 LIMIT 1', [agent]);
    await seek(resumedAt.rows[0]!.digest);
    const content = watchPool(home.stack.contentPool);
    const access = watchPool(home.stack.accessPool);
    const fuseki = home.deps.environment.fuseki;
    const queryGraph = fuseki.query.bind(fuseki);
    let graphCalls = 0;
    fuseki.query = (async (sparql: string, maxResponseBytes?: number) => {
      if (isForegroundOperation()) graphCalls += 1;
      return queryGraph(sparql, maxResponseBytes);
    }) as typeof fuseki.query;
    restore = () => {
      content.restore();
      access.restore();
      fuseki.query = queryGraph;
    };

    const read = async (cursor?: string | null, snapshot?: string): Promise<ExportPage> => {
      content.take();
      access.take();
      graphCalls = 0;
      const query = new URLSearchParams({ actingSubject: agent, ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) });
      const response = await call('GET', `/v1/me/library-export?${query}`);
      const page = await home.json<ExportPage>(response);
      const measured = { content: content.take(), access: access.take(), graphCalls };
      // Each phase seeks one page, plus the extra row that tells a full page from the last one.
      const plans = [...measured.content.plans, ...measured.access.plans];
      const returned = [...measured.content.returnedRows, ...measured.access.returnedRows];
      expect(page.profile).toBe('rezics-library-export-v1');
      expect(page.rows.length).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.page);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.responseBytes);
      expect(measured.content.inventory + measured.access.inventory).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.sqlPerPage);
      expect(measured.graphCalls).toBeGreaterThan(0);
      expect(measured.graphCalls).toBeLessThan(LIBRARY_EXPORT_COST.graphPerPage);
      for (const rows of returned) expect(rows).toBeLessThanOrEqual(LIBRARY_EXPORT_COST.page + 1);
      for (const plan of plans) assertSeek(plan);
      return page;
    };
    const collect = async (cursor: string | null, snapshot?: string) => {
      const rows: CanonicalRow[] = [];
      let next = cursor;
      let basis = snapshot;
      do {
        const page = await read(next, basis);
        basis ??= page.snapshot;
        rows.push(...page.rows);
        next = page.nextCursor;
      } while (next);
      return rows;
    };

    const acknowledged: CanonicalRow[] = [];
    let snapshot: string | undefined;
    let cursor: string | null = null;
    while (acknowledged.length < 40) {
      const page = await read(cursor, snapshot);
      expect(page.rows.length).toBeGreaterThan(0);
      snapshot = page.snapshot;
      acknowledged.push(...page.rows);
      cursor = page.nextCursor;
      expect(cursor).toBeTruthy();
    }
    // The next page arrives and the client never stores its cursor, as a reload would.
    // The cursor token is sealed with a fresh IV, so a repeat matches on rows.
    const dropped = await read(cursor, snapshot);
    expect(dropped.rows.length).toBeGreaterThan(0);
    const repeated = await read(cursor, snapshot);
    expect(repeated.profile).toBe(dropped.profile);
    expect(repeated.snapshot).toBe(snapshot);
    expect(repeated.rows).toEqual(dropped.rows);
    const resumed: CanonicalRow[] = [];
    let resumeCursor: string | null = cursor;
    do {
      const page = await read(resumeCursor, snapshot);
      if (resumed.length === 0) expect(page.rows).toEqual(dropped.rows);
      resumed.push(...page.rows);
      resumeCursor = page.nextCursor;
    } while (resumeCursor);
    const assembled = [...acknowledged, ...resumed];
    const restarted = await collect(null);
    const seeded = new Set(retained.map(row => row.sourceId));
    expect(assembled.map(row => row.sourceId)).toEqual(restarted.map(row => row.sourceId));
    expect(assembled).toEqual(restarted);
    expect(new Set(restarted.map(row => row.sourceId))).toEqual(seeded);
    expect(restarted.filter(row => row.kind === 'retained')).toHaveLength(RECORDS);
    expect(new Set(assembled.map(row => row.sourceId)).size).toBe(assembled.length);
    expect(resumed.every(row => !acknowledged.some(kept => kept.sourceId === row.sourceId))).toBe(true);
  } finally {
    restore();
    if (files && imports) await getLibraryImportApplyWorker(files, imports).stop();
    await home.stop();
  }
}, 600_000);
