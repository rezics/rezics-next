import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import { checkBatchWrite, FIELD_GROUPS, type BatchCommand, type BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createImportTransport } from './transport-driver.ts';

const native = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../../specs/fixtures/imports/api/bangumi.jsonl'), 'utf8').split('\n')[0]!,
);
function records(changed = false): SourceRecord[] {
  return [1, 2].map((id) => ({
    source: 'bangumi',
    key: String(id),
    revision: 'unversioned',
    payload: {
      ...native,
      id,
      name: changed ? 'Updated shared title' : 'Shared title',
      summary: changed ? 'Updated shared summary.' : 'Shared summary.',
      infobox: '{{Infobox animanga/TVAnime}}',
      images: {},
    },
  }));
}
const tupleKey = (source: string, externalId: string, fieldGroup: string) =>
  JSON.stringify([source, externalId, fieldGroup]);

// This local protocol server owns IDs and immutable receipts. The real HTTP adapter,
// Importer, RunStore and RecordBindings perform all planning and reconciliation.
function fixture() {
  const scratch = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(resolve(scratch, 'revision-refresh-'));
  const calls: BatchCommand[][] = [];
  const fences = new Set<string>();
  const lookups: string[] = [];
  const receipts = new Map<string, { body: string; result: BatchWriteResult['results'][number] }>();
  const statistics: { body: string; key: string | null }[] = [];
  let fault: 'denied' | 'interrupted' | 'statistic-denied' | null = null;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'local-protocol-token',
    maxAttempts: 1,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/sourceFences:check') {
        const key = tupleKey(
          url.searchParams.get('source')!,
          url.searchParams.get('externalId')!,
          url.searchParams.get('fieldGroup')!,
        );
        lookups.push(key);
        const fenced = fences.has(key);
        return Response.json({ fenced, securityRevision: fenced ? '1' : null });
      }
      if (request.method === 'PUT' && url.pathname.endsWith('/source-statistics/vndb')) {
        const body = await request.text();
        statistics.push({ body, key: request.headers.get('idempotency-key') });
        if (fault === 'statistic-denied') return Response.json({ code: 'forbidden' }, { status: 403 });
        return Response.json({ source: 'vndb', ...JSON.parse(body) });
      }
      expect(request.method).toBe('POST');
      expect(url.pathname).toBe('/v1/subjects:batchWrite');
      const body = await request.json();
      expect(checkBatchWrite(body)).toEqual([]);
      const commands = body.commands as BatchCommand[];
      calls.push(commands);
      // Recheck the exact tuple at the ordinary write boundary too.
      expect(
        commands.some((c) => fences.has(tupleKey(c.source.source, c.source.external_id, c.source.field_group))),
      ).toBe(false);
      if (fault === 'denied' && commands.some((c) => c.source.external_id === '2' && c.op === 'propose'))
        return Response.json({ code: 'forbidden' }, { status: 403 });
      return Response.json({
        results: commands.map((command) => {
          const bytes = JSON.stringify(command);
          const prior = receipts.get(command.key);
          if (prior) {
            expect(bytes).toBe(prior.body);
            return prior.result;
          }
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
          receipts.set(command.key, { body: bytes, result });
          return result;
        }),
      });
    }) as typeof fetch,
  });
  const open = () =>
    new Importer({
      path: resolve(directory, 'journal.sqlite'),
      recordConcurrency: 1,
      transport: {
        batchWrite: (request) => transport.batch(request),
        readFence: (tuple) =>
          transport.fence({
            source: tuple.source,
            externalId: tuple.external_id,
            fieldGroup: tuple.field_group,
          }),
        writeSourceStatistic: (input, signal) => transport.writeSourceStatistic(input, signal),
      },
      afterBulkSuccess(request) {
        if (
          fault === 'interrupted' &&
          request.commands.some((c) => c.op === 'propose' && c.source.external_id === '2')
        ) {
          fault = null;
          throw new Error('Local crash after server receipt before acknowledgement');
        }
      },
    });
  let importer = open();
  return {
    calls,
    fences,
    lookups,
    receipts,
    statistics,
    get importer() {
      return importer;
    },
    fail(value: typeof fault) {
      fault = value;
    },
    run(source = 'refresh', revision = 'conversion-v1', rows = records()) {
      return importer.runRecords(
        createSourceRegistration('bangumi', { source, converterRevision: revision }),
        (async function* () {
          yield* rows;
        })(),
      );
    },
    runVndb(average: number, converterRevision = 'conversion-v1') {
      return importer.runRecords(
        createSourceRegistration('vndb', { converterRevision }),
        (async function* () {
          yield {
            source: 'vndb',
            key: 'v123',
            revision: '7',
            payload: {
              vn: { id: 'v123', olang: 'en', c_average: average, c_votecount: 20, c_rating: 900 },
              entry_meta: { id: 'v123', revision: 7 },
              vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Test visual novel', latin: null }],
              vn_extlinks: [],
              extlinks: [],
            },
          };
        })(),
      );
    },
    candidates(source = 'refresh', external_id = '1') {
      return FIELD_GROUPS.flatMap((group) =>
        importer.session.bindings.candidates({ source, external_id }, group, { limit: 100 }),
      );
    },
    journals(source = 'refresh') {
      return importer.session.store.database
        .query(
          'SELECT external_id, key, bytes, signature, acknowledgement FROM binding_journal WHERE source=? ORDER BY external_id,key',
        )
        .all(source);
    },
    async reopen() {
      await importer.close();
      importer = open();
    },
    async close() {
      await importer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a new converter produces fresh same-value proposals for every record with immutable prior provenance', async () => {
  const f = fixture();
  try {
    expect((await f.run()).status).toBe('committed');
    const old = [f.candidates('refresh', '1'), f.candidates('refresh', '2')];
    const rows = ['1', '2'].map((key) => f.importer.session.store.key('refresh', key).baseline!);
    const journals = f.journals();
    const receipts = structuredClone(f.receipts);
    const start = f.calls.length;
    await f.reopen();
    expect((await f.run('refresh', 'conversion-v2')).status).toBe('committed');
    const fresh = f.calls.slice(start).flat();
    expect(fresh.some((c) => c.op === 'create')).toBe(false);
    for (const [i, external_id] of ['1', '2'].entries()) {
      const baseline = f.importer.session.store.key('refresh', external_id).baseline!;
      expect(baseline).toEqual({ ...rows[i]!, converter_revision: 'conversion-v2' });
      const current = f.candidates('refresh', external_id);
      expect(current).toHaveLength(old[i]!.length);
      expect(current.length).toBeGreaterThan(0);
      for (const candidate of current) {
        const command = JSON.parse(candidate.bytes).commands[0] as BatchCommand;
        expect(command.op).toBe('propose');
        expect(command.source).toMatchObject({
          source: 'refresh',
          external_id,
          digest: rows[i]!.digest,
          record_revision: rows[i]!.recordRevision,
          converter_revision: 'conversion-v2',
        });
        expect(old[i]!.some((prior) => prior.key === candidate.key || prior.candidate === candidate.candidate)).toBe(
          false,
        );
        expect(
          old[i]!.some(
            (prior) =>
              prior.subject === candidate.subject &&
              JSON.stringify(JSON.parse(prior.bytes).commands[0].statement) ===
                JSON.stringify('statement' in command ? command.statement : null),
          ),
        ).toBe(true);
      }
      for (const prior of old[i]!)
        expect(fresh.some((c) => c.op === 'retract' && c.candidate === prior.candidate)).toBe(true);
    }
    expect(f.journals()).toEqual(expect.arrayContaining(journals));
    for (const [key, receipt] of receipts) expect(f.receipts.get(key)).toEqual(receipt);
    await f.reopen();
    const count = f.calls.length;
    expect((await f.run('refresh', 'conversion-v2')).status).toBe('committed');
    expect(f.calls).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('a converter rollback refreshes candidates preserved under an earlier field fence', async () => {
  const f = fixture();
  try {
    expect((await f.run()).status).toBe('committed');
    const oldFacts = f.candidates().filter((c) => c.field_group === 'facts');
    expect(oldFacts.length).toBeGreaterThan(0);
    f.fences.add(tupleKey('refresh', '1', 'facts'));
    expect((await f.run('refresh', 'conversion-v2')).status).toBe('committed');
    expect(f.candidates().filter((c) => c.field_group === 'facts')).toEqual(oldFacts);
    f.fences.delete(tupleKey('refresh', '1', 'facts'));
    f.fences.add(tupleKey('refresh', '1', 'summary'));
    await f.reopen();
    const start = f.calls.length;
    expect((await f.run()).status).toBe('committed');
    const fresh = f.calls.slice(start).flat();
    expect(
      fresh.some((c) => c.op === 'propose' && c.source.external_id === '1' && c.source.field_group === 'facts'),
    ).toBe(true);
    for (const prior of oldFacts) {
      expect(f.candidates().some((c) => c.key === prior.key || c.candidate === prior.candidate)).toBe(false);
      expect(fresh.some((c) => c.op === 'retract' && c.candidate === prior.candidate)).toBe(true);
    }
  } finally {
    await f.close();
  }
});

test('unchanged, changed and reconverted inputs obey exact field, record and source fences', async () => {
  const f = fixture();
  try {
    expect((await f.run()).status).toBe('committed');
    expect((await f.run('adjacent')).status).toBe('committed');
    f.fences.add(tupleKey('refresh', '1', 'summary'));
    f.fences.add(tupleKey('refresh', '2', 'facts'));
    let start = f.calls.length;
    f.lookups.length = 0;
    expect((await f.run()).status).toBe('committed');
    expect(f.calls).toHaveLength(start);
    for (const id of ['1', '2'])
      for (const group of FIELD_GROUPS) expect(f.lookups).toContain(tupleKey('refresh', id, group));
    await f.reopen();
    expect((await f.run('refresh', 'conversion-v2')).status).toBe('committed');
    let writes = f.calls.slice(start).flat();
    expect(
      writes.some((c) => c.op === 'propose' && c.source.external_id === '1' && c.source.field_group === 'facts'),
    ).toBe(true);
    expect(
      writes.some((c) => c.op === 'propose' && c.source.external_id === '2' && c.source.field_group === 'summary'),
    ).toBe(true);
    start = f.calls.length;
    expect((await f.run('refresh', 'conversion-v3', records(true))).status).toBe('committed');
    writes = f.calls.slice(start).flat();
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.some((c) => f.fences.has(tupleKey(c.source.source, c.source.external_id, c.source.field_group))),
    ).toBe(false);
    start = f.calls.length;
    expect((await f.run('adjacent', 'conversion-v2')).status).toBe('committed');
    const adjacent = f.calls
      .slice(start)
      .flat()
      .filter((c) => c.op === 'propose');
    for (const id of ['1', '2'])
      for (const group of ['facts', 'summary'])
        expect(adjacent.some((c) => c.source.external_id === id && c.source.field_group === group)).toBe(true);
  } finally {
    await f.close();
  }
});

for (const fault of ['denied', 'interrupted'] as const) {
  test(`new-converter ${fault} recovery preserves baseline and replays only unresolved immutable envelopes`, async () => {
    const f = fixture();
    try {
      expect((await f.run()).status).toBe('committed');
      const baseline = f.importer.session.store.source('refresh');
      const journals = f.journals();
      const receipts = structuredClone(f.receipts);
      f.fail(fault);
      const start = f.calls.length;
      expect((await f.run('refresh', 'conversion-v2')).status).toBe(fault === 'denied' ? 'bulk-failed' : 'interrupted');
      expect(f.importer.session.store.source('refresh')).toEqual(baseline);
      const attempted = f.calls.slice(start);
      expect(
        attempted.some((commands) => commands.some((c) => c.op === 'propose' && c.source.external_id === '1')),
      ).toBe(true);
      const unresolved = attempted.find((commands) =>
        commands.some((c) => c.op === 'propose' && c.source.external_id === '2'),
      )!;
      expect(unresolved).toBeDefined();
      const retained = f.candidates();
      await f.reopen();
      f.fail(null);
      const resumeStart = f.calls.length;
      // New input must wait until the old revision's durable plan is drained.
      expect((await f.run('refresh', 'conversion-v3', records(true))).status).toBe('committed');
      expect(f.calls.slice(resumeStart)).toEqual([unresolved]);
      expect(f.candidates()).toEqual(retained);
      expect(f.journals()).toEqual(expect.arrayContaining(journals));
      for (const [key, receipt] of receipts) expect(f.receipts.get(key)).toEqual(receipt);
      for (const id of ['1', '2'])
        expect(f.importer.session.store.key('refresh', id).baseline?.converter_revision).toBe('conversion-v2');
      const count = f.calls.length;
      expect((await f.run('refresh', 'conversion-v2')).status).toBe('committed');
      expect(f.calls).toHaveLength(count);
    } finally {
      await f.close();
    }
  });
}

test('same-revision VNDB statistic-only retention requires success and never substitutes for new-converter proposals', async () => {
  const f = fixture();
  try {
    expect((await f.runVndb(735)).status).toBe('committed');
    const semantic = f.candidates('vndb', 'v123');
    const journals = f.journals('vndb');
    const baseline = f.importer.session.store.source('vndb');
    const row = f.importer.session.store.key('vndb', 'v123').baseline!;
    const count = f.calls.length;
    f.fail('statistic-denied');
    expect((await f.runVndb(810)).status).toBe('bulk-failed');
    expect(f.importer.session.store.source('vndb')).toEqual(baseline);
    expect(f.candidates('vndb', 'v123')).toEqual(semantic);
    const denied = f.statistics.at(-1)!;
    await f.reopen();
    f.fail(null);
    expect((await f.runVndb(810)).status).toBe('committed');
    expect(f.statistics.at(-1)).toEqual(denied);
    expect(f.calls).toHaveLength(count);
    expect(f.candidates('vndb', 'v123')).toEqual(semantic);
    expect(f.journals('vndb')).toEqual(journals);
    const refreshedRow = f.importer.session.store.key('vndb', 'v123').baseline!;
    expect(refreshedRow.recordRevision).toBe(row.recordRevision);
    expect(refreshedRow.digest).not.toBe(row.digest);
    expect((await f.runVndb(810, 'conversion-v2')).status).toBe('committed');
    expect(
      f.calls
        .slice(count)
        .flat()
        .some((c) => c.op === 'propose' && c.source.converter_revision === 'conversion-v2'),
    ).toBe(true);
    expect(f.importer.session.store.key('vndb', 'v123').baseline).toEqual({
      ...refreshedRow,
      converter_revision: 'conversion-v2',
    });
  } finally {
    await f.close();
  }
});
