import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sqliteEvidence } from '../../../specs/imports-vndb-tables-driver.ts';
import { Importer, type ImporterOptions } from '../src/importer.ts';
import { VndbInputError, VndbMaterialization } from '../src/vndb-materialization.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
async function* entries(change = false, lateInvalid = false, children?: number, alias?: string) {
  for (const name of [...names, ...(lateInvalid ? ['entry_meta'] : [])]) {
    let text = await readFile(
      new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url),
      'utf8',
    );
    if (change && name === 'vn_titles') text = text.replace('Sentinel Harbor', 'Changed Harbor');
    if (alias !== undefined && name === 'vn') text = text.replace('Harbor Sentinel', alias);
    if (children !== undefined && name === 'vn_titles')
      text =
        ['en', 'de', 'ja', 'fr', 'es', 'it', 'ru', 'ko']
          .slice(0, children)
          .map((lang) => `v123\t${lang}\tt\tTitle ${lang}\t\\N\n`)
          .join('') + 'v124\tja\tt\t港の物語\t\\N\n';
    const bytes = new TextEncoder().encode(text);
    yield {
      path: `db/${name}`,
      kind: 'file' as const,
      declaredBytes: bytes.length,
      bytes: (async function* () {
        yield bytes;
      })(),
    };
  }
}

// Local protocol double only. Native Auth/API/receipt acceptance is owned by
// vndb-materialization-native.test.ts, never inferred from these unit checks.
async function local(instrumentDatabase?: ImporterOptions['instrumentDatabase']) {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-materialization-unit-'));
  const calls: BatchWriteRequest[] = [];
  let deny = false;
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async batchWrite(body: BatchWriteRequest): Promise<BatchWriteResult> {
      calls.push(structuredClone(body));
      if (deny) throw new Error('Unit transport unavailable');
      return {
        results: body.commands.map((command) => ({
          key: command.key,
          status: 200 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
  };
  const open = () =>
    new Importer({
      path: join(directory, 'state.sqlite'),
      transport,
      sleep: async () => {},
      ...(instrumentDatabase ? { instrumentDatabase } : {}),
    });
  let importer = open();
  let facade = new VndbMaterialization(importer, undefined, { childRowsPerVn: 8, pageSize: 16 });
  return {
    get facade() {
      return facade;
    },
    get importer() {
      return importer;
    },
    calls,
    deny(value: boolean) {
      deny = value;
    },
    async stage(change = false, alias?: string) {
      const run = facade.begin();
      await facade.stage(run, entries(change, false, undefined, alias));
      return run;
    },
    async reopen() {
      await importer.close();
      importer = open();
      facade = new VndbMaterialization(importer);
    },
    async close() {
      await importer.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('materialization baseline is the actual completed RunStore row and acquisition across reopen and unchanged commit', async () => {
  const f = await local();
  try {
    const run = await f.stage();
    const grouped = f.facade.page(run, null, 1).records[0]!;
    expect(grouped.record.vn).toEqual({
      id: 'v123',
      olang: 'en',
      c_votecount: 2,
      c_average: 700,
      alias: 'Harbor Sentinel',
    });
    expect((await f.facade.commit(run)).status).toBe('committed');
    const before = f.facade.baseline('v123');
    expect(before).toEqual({
      run,
      revision: 7,
      digest: grouped.output.digest,
      converterRevision: grouped.output.converter_revision,
    });
    expect(f.importer.session.store.key('vndb', 'v123').baseline?.digest).toBe(before!.digest);
    await f.reopen();
    expect(f.facade.baseline('v123')).toEqual(before);
    f.calls.length = 0;
    expect((await f.facade.commit(run)).status).toBe('committed');
    expect(f.calls).toEqual([]);
    expect(f.facade.baseline('v123')).toEqual(before);
    const changed = await f.stage(true);
    expect((await f.facade.commit(changed)).status).toBe('committed');
    expect(f.facade.baseline('v123')!.run).toBe(changed);
    expect(f.facade.baseline('v123')!.digest).not.toBe(before!.digest);
  } finally {
    await f.close();
  }
});

test('measured stage and page leave SQLite ready for ordinary publication at every supported child cardinality', async () => {
  const evidence = sqliteEvidence();
  const f = await local((db) => {
    evidence.attach(db);
    return db;
  });
  try {
    for (const children of [2, 4, 8]) {
      const run = f.facade.begin();
      evidence.start();
      await f.facade.stage(run, entries(false, false, children));
      evidence.finish();
      evidence.start();
      const page = f.facade.page(run, null, 1);
      evidence.finish();
      expect(page.records[0]!.record.vn_titles).toHaveLength(children);
      expect((await f.facade.commit(run)).status).toBe('committed');
    }
  } finally {
    await f.close();
  }
});

test('new and late-invalid table generations cannot publish or replace a completed baseline', async () => {
  const f = await local();
  try {
    await f.facade.commit(await f.stage());
    const before = f.facade.baseline('v123');
    f.calls.length = 0;
    const run = f.facade.begin();
    await expect(f.facade.commit(run)).rejects.toBeInstanceOf(VndbInputError);
    await expect(f.facade.stage(run, entries(true, true))).rejects.toBeInstanceOf(VndbInputError);
    await expect(f.facade.commit(run)).rejects.toBeInstanceOf(VndbInputError);
    expect(f.calls).toEqual([]);
    await f.reopen();
    expect(f.facade.baseline('v123')).toEqual(before);
  } finally {
    await f.close();
  }
});

test('native aliases survive bootstrap, bound refresh, removal and durable replay', async () => {
  const f = await local();
  try {
    const original = await f.stage();
    expect((await f.facade.commit(original)).status).toBe('committed');
    const commands = () => f.calls.flatMap((request) => request.commands);
    expect(commands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'create',
          subject: expect.objectContaining({ aliases: { und: ['Harbor Sentinel'] } }),
        }),
      ]),
    );
    const digest = f.facade.baseline('v123')!.digest;

    f.calls.length = 0;
    f.deny(true);
    const changed = await f.stage(false, 'Harbor Watch\\nHarbor Guard');
    const row = f.facade.page(changed, null, 16).records.find((record) => record.key === 'v123')!;
    expect(row.output.digest).not.toBe(digest);
    expect(row.output.record_revision).toBe('7');
    expect((await f.facade.commit(changed)).status).toBe('bulk-failed');
    expect(f.facade.baseline('v123')!.digest).toBe(digest);
    const replay = structuredClone(f.calls[0]!);
    expect(commands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'propose',
          source: expect.objectContaining({ external_id: 'v123' }),
          statement: expect.objectContaining({
            property: { id: 'schema:alternateName' },
            value: { type: 'value', content: { language: 'und', text: 'Harbor Watch' } },
          }),
        }),
      ]),
    );

    await f.reopen();
    f.deny(false);
    f.calls.length = 0;
    const removed = await f.stage(false, '\\N');
    expect((await f.facade.commit(removed)).status).toBe('committed');
    expect(f.calls[0]).toEqual(replay);
    expect(f.facade.baseline('v123')!.run).toBe(changed);
    f.calls.length = 0;
    expect((await f.facade.commit(removed)).status).toBe('committed');
    expect(f.facade.baseline('v123')!.run).toBe(removed);
    expect(commands().some((command) => command.op === 'retract')).toBe(true);
  } finally {
    await f.close();
  }
});
