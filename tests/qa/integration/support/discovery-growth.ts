import { expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaStack } from '../media-support.ts';
import { measureGraphResponses } from './graph-responses.ts';
import { meterNativeReadWork, type NativeReadWork } from './native-read-work.ts';
import { meterSqlReadWork, type SqlReadWork } from './sql-read-work.ts';

export interface DiscoveryReading {
  read: string; size: number; page: number; servedMs: number;
  graphCalls: number; graphRows: number; sql: SqlReadWork; native: NativeReadWork;
}

export function discoveryGrowthMeter(selectSql: (sql: string) => boolean = () => true) {
  const sql = meterSqlReadWork(selectSql), native = meterNativeReadWork();
  const evidence: DiscoveryReading[] = [];
  return {
    evidence,
    async measure<T>(stack: MediaStack, read: string, size: number, page: number, request: () => Promise<Response>) {
      const started = performance.now();
      const served = await request();
      const raw = await served.text();
      const servedMs = performance.now() - started;
      expect(served.status, raw).toBe(200);
      const measured = await measureGraphResponses(stack.fuseki, () => native.measure(() => sql.measure(request)));
      const response = measured.value.result.result;
      const text = await response.text();
      expect(response.status, text).toBe(200);
      evidence.push({ read, size, page, servedMs, ...measured.cost,
        sql: measured.value.result.work, native: measured.value.work });
      return JSON.parse(text) as T;
    },
    finish(name: string) {
      const failures: string[] = [];
      for (const row of evidence) {
        const first = evidence.find(prior => prior.read === row.read && prior.page === row.page)!;
        const label = `${row.read} size=${row.size} page=${row.page}`;
        for (const [field, actual, baseline, slack] of [
          ['graphCalls', row.graphCalls, first.graphCalls, 2],
          ['graphRows', row.graphRows, first.graphRows, 8],
          ['SQL rows touched', row.sql.rowsTouched, first.sql.rowsTouched, 16],
          ['SQL statements', row.sql.statements, first.sql.statements, 2],
        ] as const) if (actual > baseline + slack) failures.push(`${label}: ${field} ${actual} > ${baseline} + ${slack}`);
        for (const counter of ['rank_lucene_iterator_next_calls', 'rank_lucene_iterator_advance_calls',
          'typeahead_prefix_entries_visited']) {
          const actual = row.native.counters[counter], baseline = first.native.counters[counter];
          if (baseline !== undefined && actual === undefined) failures.push(`${label}: missing ${counter}`);
          if (actual !== undefined && baseline !== undefined && actual > baseline + 16)
            failures.push(`${label}: ${counter} ${actual} > ${baseline} + 16`);
        }
      }
      const directory = process.env.REZICS_QA_ARTIFACT_DIR ?? '.temp/public-discovery-growth';
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${name}-growth.json`), JSON.stringify({ evidence, failures }, null, 2));
      writeFileSync(join(directory, `${name}-growth-${process.env.REZICS_QA_RUN_ID}.json`), JSON.stringify({ evidence, failures }, null, 2));
      console.log(`${name} growth`, JSON.stringify(evidence.map(({ sql: work, native, ...row }) => ({ ...row,
        sql: { statements: work.statements, rowsTouched: work.rowsTouched }, native: { calls: native.calls,
          counters: Object.fromEntries(Object.entries(native.counters).filter(([, count]) => count > 0)) } }))));
      return failures;
    },
    restore() { native.restore(); sql.restore(); },
  };
}
