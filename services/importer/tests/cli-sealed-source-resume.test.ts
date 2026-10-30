import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import entity from '../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../src/cli.ts';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';

// Local protocol doubles prove CLI acquisition ordering only; the frozen kernel case owns native effects.
for (const source of ['vndb', 'wikidata'] as const) {
  test(`${source} CLI keeps its acquisition contract when sealed work meets malformed replacement input`, async () => {
    const directory = await mkdtemp('/dev/shm/import-sealed-unit-');
    try {
      const state = join(directory, 'state.sqlite');
      const keyPath = join(directory, 'operator.jwk');
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      await writeFile(
        keyPath,
        JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
        { mode: 0o600 },
      );
      const argv = [
        '--source',
        source,
        '--dump',
        '-',
        '--state',
        state,
        '--api',
        'https://api.test',
        '--auth',
        'https://auth.test',
        '--account-key',
        keyPath,
        '--account',
        randomUUID(),
        '--client',
        'local',
      ];
      const sent: string[] = [];
      const statistics: unknown[] = [];
      const receipts = new Map<string, BatchWriteResult['results'][number]>();
      let lose = false;
      let controller = new AbortController();
      const transport = {
        async readFence() {
          return { fenced: false, securityRevision: null };
        },
        async writeSourceStatistic(value: unknown) {
          statistics.push(value);
        },
        async batchWrite(body: BatchWriteRequest): Promise<BatchWriteResult> {
          sent.push(JSON.stringify(body));
          const results = body.commands.map((command) => {
            const prior = receipts.get(command.key);
            if (prior) return prior;
            const result = {
              key: command.key,
              status: 200 as const,
              value:
                command.op === 'create'
                  ? { id: randomUUID(), revision: 1 }
                  : command.op === 'propose'
                    ? { candidate: randomUUID(), revision: 1 }
                    : { revision: 1 },
            };
            receipts.set(command.key, result);
            return result;
          });
          if (lose && body.commands.some((command) => command.op === 'propose')) {
            controller.abort(new DOMException('Local committed response loss', 'AbortError'));
            throw controller.signal.reason;
          }
          return { results };
        },
      };
      const inspect = () => {
        const session = new ImportSession(state);
        try {
          const active = session.store.activeRun(source);
          return {
            source: session.store.source(source),
            record: session.store.key(source, source === 'vndb' ? 'v123' : entity.id),
            pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
            acquisition:
              source === 'vndb'
                ? session.store.database
                    .query('SELECT run_id FROM vndb_table_runs WHERE source=? AND materialized_generation=?')
                    .get(source, session.store.source(source).generation)
                : null,
          };
        } finally {
          session.close();
        }
      };
      async function invoke(generation: number, invalid = false) {
        let consumed = 0;
        controller = new AbortController();
        const record = structuredClone(entity);
        record.lastrevid += generation;
        record.labels.en.value = `Book generation ${generation}`;
        const bytes = new TextEncoder().encode(`[\n${JSON.stringify(record)}\n${invalid ? '' : ']\n'}`);
        const entries = (async function* () {
          const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
          for (const name of [...names, ...(invalid ? ['entry_meta'] : [])]) {
            let text = readFileSync(
              new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url),
              'utf8',
            );
            if (name === 'vn_titles') text = text.replace('Sentinel Harbor', `Harbor generation ${generation}`);
            if (name === 'entry_meta') text = text.replace('\t7\t6\t3', `\t${7 + generation}\t6\t3`);
            const bytes = new TextEncoder().encode(text);
            consumed += bytes.length;
            yield {
              path: `db/${name}`,
              kind: 'file' as const,
              declaredBytes: bytes.length,
              bytes: (async function* () {
                yield bytes;
              })(),
            };
          }
        })();
        const result = await runImportCli(argv, {
          signal: controller.signal,
          ...(source === 'vndb' ? { entries } : {}),
          stdin: (async function* () {
            consumed += bytes.length;
            yield bytes;
          })(),
          createImporter(options) {
            return new Importer({ ...options, transport });
          },
          fetch: (async () => {
            throw new Error('Local protocol proof must not contact Auth or the API');
          }) as unknown as typeof fetch,
        });
        expect(result.openHandles).toBe(0);
        return { ...result, consumed };
      }
      expect((await invoke(0)).code).toBe(0);
      const baseline = inspect();
      lose = true;
      expect([1, 130]).toContain((await invoke(1)).code);
      const pending = inspect();
      expect(pending.source).toEqual(baseline.source);
      expect(pending.pending).toHaveLength(1);
      lose = false;
      const receiptCount = receipts.size;
      let offset = sent.length;
      const statsCount = statistics.length;
      if (source === 'vndb') {
        expect((await invoke(2, true)).code).toBe(2);
        expect(inspect()).toEqual(pending);
        expect(sent.length).toBe(offset);
        expect(statistics.length).toBe(statsCount);
      }
      const resumed = await invoke(2, source === 'wikidata');
      expect(resumed.code).toBe(0);
      if (source === 'wikidata') expect(resumed.consumed).toBe(0);
      else expect(resumed.consumed).toBeGreaterThan(0);
      expect(sent.slice(offset)).toEqual(pending.pending.map((row) => row.bytes));
      expect(receipts.size).toBe(receiptCount);
      expect(inspect().record.baseline!.recordRevision).toBe(String(source === 'vndb' ? 8 : entity.lastrevid + 1));
      const drained = inspect();
      if (source === 'vndb') expect(drained.acquisition).not.toEqual(baseline.acquisition);
      offset = sent.length;
      expect((await invoke(2, true)).code).toBe(2);
      expect(sent.length).toBe(offset);
      expect(inspect().source).toEqual(drained.source);
      expect((await invoke(2)).code).toBe(0);
      expect(inspect().record.baseline!.recordRevision).toBe(String(source === 'vndb' ? 9 : entity.lastrevid + 2));
      expect(sent.length).toBeGreaterThan(offset);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
