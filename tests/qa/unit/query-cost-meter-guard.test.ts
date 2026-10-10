import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { runWorkerTick } from '../../../services/main/src/worker-tick.ts';
import { runBackgroundOperation } from '../integration/support/operation-cost.ts';
import { foregroundCounted, meterFuseki, meterPool } from '../integration/support/query-cost-meter.ts';

const root = join(import.meta.dir, '../../..');
const scanRoots = ['tests/qa', 'services/main/tests'];

/** Wrappers that record a stack query without the shared foreground meter. */
const allowlist: Record<string, string> = {
  'services/main/tests/claim-statement-fold.test.ts':
    'Canned Fuseki doubles, including http://unused.invalid, replace query to serve fixture rows. They are not the client background workers share.',
  'tests/qa/integration/zone-document-home.test.ts':
    'Counts rv:publishedPage membership probes. Worker ticks do not issue that shape, and another task holds the file.',
};

const wrapPattern = /\.query\s*=|(?:property|key|member|name|field)\s*===\s*['"]query['"]|override\s+async\s+query\s*\(/g;
const countsPattern = /(?:\+\+|\.push\s*\()/;

function sliceBody(source: string, from: number): string {
  const brace = source.indexOf('{', from);
  const arrow = source.indexOf('=>', from);
  if (brace < 0) return source.slice(from, from + 500);
  if (arrow !== -1 && arrow < brace && arrow < from + 120) {
    const after = source.slice(arrow + 2).trimStart();
    if (!after.startsWith('{')) {
      const end = source.indexOf('\n', arrow);
      return source.slice(from, end === -1 ? arrow + 400 : Math.min(source.length, end + 240));
    }
  }
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  const end = Math.min(source.length, brace + 2500);
  for (let i = brace; i < end; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? end : newline;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from, end);
}

function introducesWrapper(source: string, from: number): boolean {
  const head = source.slice(from, from + 160);
  if (/===\s*['"]query['"]/.test(head) || /override\s+async\s+query/.test(head)) return true;
  const statement = head.split(';')[0] ?? head;
  return /async|function|=>/.test(statement);
}

/** Query wrappers in this source that count calls and do not consult the meter. */
export function unmeteredQueryCounters(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(wrapPattern)) {
    const from = match.index ?? 0;
    if (!introducesWrapper(source, from)) continue;
    const body = sliceBody(source, from);
    if (!countsPattern.test(body) || body.includes('foregroundCounted(') || body.includes('isBackgroundContext')) continue;
    if (!/super\.query\s*\(|target\.query\s*\(|\boriginal|\bnative\b|\.query\(/.test(body)) continue;
    const lead = source.slice(Math.max(0, from - 180), from + 40);
    const stackClient = /(?:fuseki|contentPool|accessPool|prototype)\s*\.\s*query/i.test(lead)
      || (/override\s+async\s+query/.test(lead) && /super\.query\s*\(/.test(body))
      || (/===\s*['"]query['"]/.test(lead) && /new Proxy\([\s\S]{0,400}$/.test(source.slice(Math.max(0, from - 400), from))
        && /fuseki|contentPool|accessPool|Pool/.test(source.slice(Math.max(0, from - 400), from)));
    if (!stackClient) continue;
    const line = source.slice(0, from).split('\n').length;
    found.push(`${line}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('meter counts the caller and skips scheduler boundaries and worker ticks', async () => {
  const calls: string[] = [];
  const client = {
    async query(sparql: string) {
      calls.push(sparql);
      return { results: { bindings: [{ sparql: { type: 'literal', value: sparql } }] } };
    },
  } as unknown as FusekiClient;
  const metered = meterFuseki(client);
  await metered.query('read');
  await runBackgroundOperation(() => metered.query('scheduler'));
  await runWorkerTick('directory.refresh', () => metered.query('tick'));
  expect(calls).toEqual(['read', 'scheduler', 'tick']);
  expect(metered.queries).toBe(1);
  expect(metered.bytes).toBeGreaterThan(0);
  metered.reset();
  expect(metered.queries).toBe(0);
  expect(metered.bytes).toBe(0);
  expect(foregroundCounted()).toBe(true);
  expect(runBackgroundOperation(() => foregroundCounted())).toBe(false);
  expect(await runWorkerTick('directory.refresh', () => foregroundCounted())).toBe(false);

  const pool = meterPool({
    query: async () => ({ rows: [{ n: 1 }] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  } as unknown as Pool);
  await pool.query('select 1');
  await runWorkerTick('feed.refresh', async () => { await pool.query('select tick'); });
  const clientQuery = await pool.connect();
  await clientQuery.query('select checkout');
  expect(pool.queries).toBe(2);
  pool.reset();
  expect(pool.queries).toBe(0);
});

test('a query counter that skips the meter is rejected', () => {
  const raw = 'stack.fuseki.query = async (sparql) => { queries.push(sparql); return native(sparql); };';
  expect(unmeteredQueryCounters(raw)).toHaveLength(1);
  const metered = `import { foregroundCounted } from '../integration/support/query-cost-meter.ts';
    stack.fuseki.query = async (sparql) => { if (foregroundCounted()) queries.push(sparql); return native(sparql); };`;
  expect(unmeteredQueryCounters(metered)).toEqual([]);
  const proxied = `new Proxy(fuseki, { get(target, property) {
    if (property === 'query') return async () => { graphQueries++; return target.query(); };
  } });`;
  expect(unmeteredQueryCounters(proxied)).toHaveLength(1);
});

test('stack query counters use the shared meter', () => {
  const offenders: string[] = [];
  const stale: string[] = [];
  for (const scanRoot of scanRoots) {
    for (const path of walk(join(root, scanRoot))) {
      const file = relative(root, path);
      if (file === 'tests/qa/unit/query-cost-meter-guard.test.ts') continue;
      const source = readFileSync(path, 'utf8');
      const hits = unmeteredQueryCounters(source);
      const reason = allowlist[file];
      if (reason) {
        if (!hits.length) stale.push(file);
        continue;
      }
      if (hits.length) offenders.push(`${file}\n  ${hits.join('\n  ')}`);
    }
  }
  for (const file of Object.keys(allowlist)) {
    if (!existsSync(join(root, file))) stale.push(`${file} missing`);
  }
  expect(stale, 'allowlist entries must still be unmetered counters').toEqual([]);
  expect(offenders, 'wrap the stack client with meterFuseki, meterPool, or foregroundCounted()').toEqual([]);
});
