import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { Importer } from '../src/importer.ts';
import type { ImportTransport } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { observationDigest } from '../src/source-observation.ts';

const SCALES = [32, 64, 128] as const;
const HISTORY = 40;
const registration = createSourceRegistration('vndb');

function vn(index: number): SourceRecord {
  const key = `v${index}`;
  return {
    source: 'vndb',
    key,
    revision: '7',
    payload: {
      vn: { id: key, olang: 'en', c_average: 700, c_votecount: 10, c_rating: 900 },
      entry_meta: { id: key, revision: 7 },
      vn_titles: [{ id: key, lang: 'en', official: true, title: `VN ${index}`, latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

test('32/64/128 VNDB observation intents stay O(N+A+R) with indexed pages and fixed history', async () => {
  const samples: { n: number; puts: number; heads: number; figures: number; journal: number; pages: number }[] = [];
  for (const n of SCALES) {
    const directory = await mkdtemp(join(tmpdir(), 'obs-growth-'));
    const sequence = { value: 0 };
    let puts = 0;
    let heads = 0;
    let figures = 0;
    let journal = 0;
    let pages = 0;
    const metadata = sourceRecordMetadataFixture();
    const stored = new Map<string, Record<string, unknown>>();
    const transport = {
      setSourceRecordMetadata: metadata.setSourceRecordMetadata,
      async batchWrite(request: BatchWriteRequest) {
        return {
          results: request.commands.map((command) => {
            sequence.value++;
            if (command.op === 'create')
              return {
                key: command.key,
                status: 201,
                value: { id: `00000000-0000-4000-8000-${sequence.value.toString().padStart(12, '0')}`, revision: 1 },
              };
            if (command.op === 'propose')
              return {
                key: command.key,
                status: 201,
                value: {
                  candidate: `00000000-0000-4000-8000-${sequence.value.toString().padStart(12, '0')}`,
                  revision: 1,
                },
              };
            return { key: command.key, status: 200, value: { revision: 1 } };
          }),
        } satisfies BatchWriteResult;
      },
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async readSourceStatistics(input: { subjectId: string }) {
        heads++;
        const row = stored.get(input.subjectId);
        return row ? [{ source: 'vndb', ...row }] : [];
      },
      async readPublicFigure() {
        figures++;
        return { count: 10, state: 'ready', mean: 7 };
      },
      async writeSourceStatistic(input: { subjectId: string; value: Record<string, unknown> }) {
        puts++;
        stored.set(input.subjectId, input.value);
        return {
          source: 'vndb',
          ...input.value,
          observation: { kind: 'unversioned', digest: observationDigest(input.subjectId, input.value as never) },
        };
      },
    } as unknown as ImportTransport;
    const importer = new Importer({
      path: join(directory, 'state.sqlite'),
      transport,
      instrumentDatabase: (database) => {
        const original = database.prepare.bind(database);
        database.prepare = ((sql: string) => {
          const statement = original(sql);
          if (sql.includes('run_aggregate_operations') || sql.includes('run_aggregate_heads')) {
            const count = () => {
              journal++;
              if (sql.includes('ORDER BY operation_id LIMIT')) pages++;
            };
            const get = statement.get.bind(statement);
            const all = statement.all.bind(statement);
            const run = statement.run.bind(statement);
            statement.get = ((...args: Parameters<typeof get>) => {
              count();
              return get(...args);
            }) as typeof statement.get;
            statement.all = ((...args: Parameters<typeof all>) => {
              count();
              return all(...args);
            }) as typeof statement.all;
            statement.run = ((...args: Parameters<typeof run>) => {
              count();
              return run(...args);
            }) as typeof statement.run;
          }
          expect(sql.replace(/\s+/g, ' ')).not.toMatch(/FROM run_aggregate_operations(?! WHERE)/);
          return statement;
        }) as typeof database.prepare;
        return database;
      },
    });
    try {
      const insert = importer.session.store.database.prepare(`INSERT INTO run_aggregate_operations(
        source,run_id,operation_id,record_key,subject_id,provider,source_alias,source_record_id,kind,
        command_key,request_bytes,intended_json,reviewed_head_json,expected_observation,status,native_reason,outcome_json)
        VALUES('history','1',?,'h','00000000-0000-4000-8000-000000000099','vndb','vndb','v0','write',
        'k','{}','{}',NULL,NULL,'delivered',NULL,NULL)`);
      for (let index = 1; index <= HISTORY; index++) insert.run(index.toString(16).padStart(64, '0'));
      const result = await importer.runRecords(
        registration,
        (async function* () {
          for (let index = 1; index <= n; index++) yield vn(index);
        })(),
      );
      expect(result.status).toBe('committed');
      const page = await importer.pageObservationConflicts('vndb', undefined, 20);
      expect(page.operations.length).toBeLessThanOrEqual(20);
      samples.push({ n, puts, heads, figures, journal, pages });
    } finally {
      await importer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  const [a, b, c] = samples;
  expect(a && b && c).toBeTruthy();
  expect(a!.puts).toBe(32);
  expect(b!.puts).toBe(64);
  expect(c!.puts).toBe(128);
  expect(a!.heads).toBeGreaterThanOrEqual(32);
  expect(c!.puts / a!.puts).toBe(4);
  expect(c!.heads / a!.heads).toBeCloseTo(4, 0);
  expect(c!.journal / a!.journal).toBeLessThan(6);
  expect(samples.every((sample) => sample.pages >= 1)).toBe(true);
});
