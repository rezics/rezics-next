import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMediaStack } from './media-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { measureGraphResponses } from './support/graph-responses.ts';
import { meterSqlReadWork, prepareSqlReadWork, type SqlReadWork } from './support/sql-read-work.ts';

interface Page { items: { id: string }[]; nextCursor: string | null }
interface Reading { read: string; size: number; page: number; graphCalls: number; graphRows: number;
  servedMs: number; sql: SqlReadWork }

test('public directory first and next pages visit a fixed neighbourhood as Realms grow', async () => {
  await prepareSqlReadWork();
  const sql = meterSqlReadWork(() => true, text => /FROM access\.realm_directory(?:_growth)? [dg]\b/.test(text));
  const stack = await startMediaStack('public-directory-growth');
  const evidence: Reading[] = [];
  const failures: string[] = [];
  const started = performance.now();
  try {
    const owner = await stack.member('directory-growth-owner');
    await owner.grant('space:create:root', 'space.create');
    let count = 0;
    for (const size of [10, 32, 100]) {
      for (; count < size; count++) {
        const response = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
          name: `Growth directory ${count}`, capabilities: ['realm'], actingSubject: owner.actor });
        expect(response.status, await response.clone().text()).toBe(201);
      }
      await waitForRealmDirectory(stack.env, () => stack.call('GET', '/v1/realms?limit=2'));
      expect(performance.now() - started, 'fixture preparation stays below ten minutes').toBeLessThan(600_000);
      for (const sort of ['newest', 'activity', 'members', 'growing']) {
        for (const q of ['', 'Growth']) {
          const read = `directory/${sort}${q ? '/search' : ''}`;
          let cursor: string | null = null;
          const seen = new Set<string>();
          for (let page = 0; page < 2; page++) {
            const path = `/v1/realms?${new URLSearchParams({ sort, limit: '2', ...(q ? { q } : {}),
              ...(cursor ? { cursor } : {}) })}`;
            const servedStart = performance.now();
            const served = await stack.call('GET', path);
            const servedText = await served.text();
            const servedMs = performance.now() - servedStart;
            expect(served.status, servedText).toBe(200);
            const measured = await measureGraphResponses(stack.fuseki,
              () => sql.measure(() => stack.call('GET', path)));
            const response = measured.value.result;
            const text = await response.text();
            expect(response.status, text).toBe(200);
            const result = JSON.parse(text) as Page;
            expect(result.items).toHaveLength(2);
            for (const item of result.items) {
              expect(seen.has(item.id), 'continuation cannot repeat a Realm').toBe(false);
              seen.add(item.id);
            }
            expect(result.nextCursor).toBeString();
            cursor = result.nextCursor;
            expect(measured.value.work.plans.some(plan => /FROM access\.realm_directory(?:_growth)? [dg]\b/.test(plan.sql))).toBe(true);
            evidence.push({ read, size, page, ...measured.cost, servedMs, sql: measured.value.work });
          }
        }
      }
    }
    for (const row of evidence) {
      const baseline = evidence.find(prior => prior.read === row.read && prior.page === row.page)!;
      const message = `${row.read} page=${row.page} size=${row.size}`;
      if (row.sql.rowsTouched > baseline.sql.rowsTouched + 16)
        failures.push(`${message}: SQL scan visits ${row.sql.rowsTouched} > ${baseline.sql.rowsTouched} + 16`);
      if (row.graphCalls > baseline.graphCalls + 2)
        failures.push(`${message}: graph calls ${row.graphCalls} > ${baseline.graphCalls} + 2`);
      if (row.graphRows > baseline.graphRows + 4)
        failures.push(`${message}: graph rows ${row.graphRows} > ${baseline.graphRows} + 4`);
    }
  } finally {
    const directory = process.env.REZICS_QA_ARTIFACT_DIR ?? '.temp/public-discovery-growth';
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'directory-growth.json'), JSON.stringify({ evidence, failures }, null, 2));
    writeFileSync(join(directory, `directory-growth-${process.env.REZICS_QA_RUN_ID}.json`), JSON.stringify({ evidence, failures }, null, 2));
    console.log('directory growth', JSON.stringify(evidence.map(({ sql: work, ...row }) => ({ ...row,
      sqlStatements: work.statements, sqlRowsTouched: work.rowsTouched }))));
    sql.restore();
    await stack.stop();
  }
  expect(failures, failures.join('\n')).toEqual([]);
}, 600_000);
