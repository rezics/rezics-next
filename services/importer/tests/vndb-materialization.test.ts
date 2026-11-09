import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sqliteEvidence } from '../../../specs/imports-vndb-tables-driver.ts';
import { Importer, type ImporterOptions } from '../src/importer.ts';
import { VndbInputError, VndbMaterialization } from '../src/vndb-materialization.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import type { ImportTransport, SourceRegistration } from '../src/import-contract.ts';

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
async function local(instrumentDatabase?: ImporterOptions['instrumentDatabase'], registration?: SourceRegistration) {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp('.temp/vndb-materialization-unit-');
  const calls: BatchWriteRequest[] = [];
  const statistics: Parameters<NonNullable<ImportTransport['writeSourceStatistic']>>[0][] = [];
  let deny = false;
  let denyStatistics = false;
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
    async writeSourceStatistic(input: (typeof statistics)[number]) {
      statistics.push(structuredClone(input));
      if (denyStatistics) throw new Error('Unit statistic response unavailable');
    },
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
  let facade = new VndbMaterialization(importer, registration, { childRowsPerVn: 8, pageSize: 16 });
  return {
    get facade() {
      return facade;
    },
    get importer() {
      return importer;
    },
    calls,
    statistics,
    deny(value: boolean) {
      deny = value;
    },
    denyStatistics(value: boolean) {
      denyStatistics = value;
    },
    async stage(change = false, alias?: string, timestamp?: string) {
      const run = facade.begin();
      await facade.stage(
        run,
        (async function* () {
          yield* entries(change, false, undefined, alias);
          if (timestamp !== undefined) {
            const bytes = new TextEncoder().encode(timestamp);
            yield {
              path: 'TIMESTAMP',
              kind: 'file' as const,
              declaredBytes: bytes.length,
              bytes: (async function* () {
                yield bytes;
              })(),
            };
          }
        })(),
      );
      return run;
    },
    async reopen() {
      await importer.close();
      importer = open();
      facade = new VndbMaterialization(importer, registration);
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
}, 15_000);

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

test('interrupted publication and a later different archive keep the last complete baseline', async () => {
  const f = await local();
  try {
    const original = await f.stage();
    expect((await f.facade.commit(original)).status).toBe('committed');
    const before = f.facade.baseline('v123');
    f.deny(true);
    const changed = await f.stage(true);
    expect((await f.facade.commit(changed)).status).toBe('bulk-failed');
    expect(f.facade.baseline('v123')).toEqual(before);
    const other = await f.stage(false, 'Other Sentinel');
    f.deny(false);
    expect((await f.facade.commit(other)).status).toBe('committed');
    expect(f.facade.baseline('v123')!.run).toBe(changed);
    expect(f.facade.baseline('v123')!.digest).not.toBe(before!.digest);
    expect(
      f.facade.page(changed, null, 1).records[0]!.record.vn_titles.find((title) => title.lang === 'en')!.title,
    ).toBe('Changed Harbor');
    await f.reopen();
    expect(f.facade.baseline('v123')!.run).toBe(changed);
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

test('VNDB table materialization preserves SQL NULL and exact empty aliases across reopen', async () => {
  const f = await local();
  try {
    const nullRun = await f.stage(false, '\\N');
    const nullRecord = f.facade.page(nullRun, null, 16).records.find((record) => record.key === 'v123')!;
    expect(nullRecord.record.vn.alias).toBeNull();
    expect(nullRecord.output.normalizedRecord.vn.alias).toBeNull();
    expect(nullRecord.output.proposals[0]?.op === 'create' && nullRecord.output.proposals[0].subject).not.toHaveProperty(
      'aliases',
    );

    const emptyRun = await f.stage(false, '');
    const emptyRecord = f.facade.page(emptyRun, null, 16).records.find((record) => record.key === 'v123')!;
    expect(emptyRecord.record.vn.alias).toBe('');
    expect(emptyRecord.output.normalizedRecord.vn.alias).toBe('');
    expect(emptyRecord.output.digest).not.toBe(nullRecord.output.digest);
    expect(emptyRecord.output.proposals[0]?.op === 'create' && emptyRecord.output.proposals[0].subject).not.toHaveProperty(
      'aliases',
    );

    await f.reopen();
    const reopened = f.facade.page(emptyRun, null, 16).records.find((record) => record.key === 'v123')!;
    expect(reopened.record.vn.alias).toBe('');
    expect(reopened.output.normalizedRecord.vn.alias).toBe('');
    expect(reopened.output.digest).toBe(emptyRecord.output.digest);
  } finally {
    await f.close();
  }
});

test('archive snapshot provenance survives ready reopen and sealed recovery before a successor date', async () => {
  const f = await local();
  try {
    const missing = await f.stage();
    expect((await f.facade.commit(missing)).status).toBe('committed');
    expect(f.statistics).toEqual([]);
    const dated = await f.stage(false, undefined, '2026-10-25 08:00:24+00\n');
    const snapshot = f.facade.acquisition(dated).sourceSnapshot!;
    expect(snapshot).toMatchObject({ timestamp: '2026-10-25 08:00:24+00', asOf: '2026-10-25' });
    expect(snapshot.membersDigest).toMatch(/^[a-f0-9]{64}$/);
    await f.reopen();
    expect(f.facade.acquisition(dated).sourceSnapshot).toEqual(snapshot);
    f.denyStatistics(true);
    expect((await f.facade.commit(dated)).status).toBe('bulk-failed');
    const sealed = structuredClone(f.statistics[0]!);
    expect(sealed.value).toMatchObject({ sourceRecordId: 'v123', asOf: '2026-10-25', mean: 7, count: 2 });
    const generation = f.importer.session.store.source('vndb').generation;
    const successor = await f.stage(false, undefined, '2026-10-26 08:00:24+00\n');
    await f.reopen();
    f.denyStatistics(false);
    f.statistics.length = 0;
    expect((await f.facade.commit(successor)).status).toBe('committed');
    expect(f.statistics[0]).toEqual(sealed);
    expect(f.statistics.every((input) => input.value.asOf === '2026-10-25')).toBe(true);
    expect(f.importer.session.store.source('vndb').generation).not.toBe(generation);
    f.statistics.length = 0;
    expect((await f.facade.commit(successor)).status).toBe('committed');
    expect(f.statistics.every((input) => input.value.asOf === '2026-10-26')).toBe(true);
    expect(f.statistics.length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test('sealed observation intent survives a caller registration date change without archive provenance', async () => {
  const options = { sourceSnapshotAsOf: '2026-10-25' };
  const f = await local(undefined, createSourceRegistration('vndb', options));
  try {
    f.denyStatistics(true);
    expect((await f.facade.commit(await f.stage())).status).toBe('bulk-failed');
    const sealed = structuredClone(f.statistics[0]!);
    options.sourceSnapshotAsOf = '2026-10-26';
    await f.reopen();
    f.denyStatistics(false);
    f.statistics.length = 0;
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    expect(f.statistics[0]).toEqual(sealed);
    expect(f.statistics.every((input) => input.value.asOf === '2026-10-25')).toBe(true);
  } finally {
    await f.close();
  }
});

test('invalid archive snapshot dates cannot publish or replace the completed generation', async () => {
  const f = await local();
  try {
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    const before = f.facade.baseline('v123');
    for (const timestamp of ['2026-02-30 08:00:24+00\n', '2026-10-25 24:00:00+00\n', 'x'.repeat(65)])
      await expect(f.stage(false, undefined, timestamp)).rejects.toThrow();
    expect(f.facade.baseline('v123')).toEqual(before);
    expect(f.statistics).toEqual([]);
  } finally {
    await f.close();
  }
});

test('unchanged VNDB rows refresh newly reviewed tag bindings and preserve unrelated candidates', async () => {
  const { bundledDigest } = await import('@rezics/definitions/bundled');
  const { vndbPublicTagScheme, vndbPublicTagTaxonomy } = await import('../../../packages/conversion/src/support.ts');
  const native = createSourceRegistration('vndb');
  const schemeId = randomUUID();
  let conceptId: string | undefined;
  const registration: SourceRegistration = {
    ...native,
    convert(input, context) {
      return native.convert(
        input,
        input.external_id !== 'v123'
          ? context
          : {
              ...context,
              sourceVocabulary: {
                bindings: {
                  releaseDigest: bundledDigest,
                  schemes: [
                    {
                      taxonomy: vndbPublicTagTaxonomy('cont'),
                      uri: vndbPublicTagScheme('cont'),
                      id: schemeId,
                      type: 'skos:ConceptScheme',
                      releaseDigest: bundledDigest,
                    },
                  ],
                  concepts: conceptId
                    ? [
                        {
                          taxonomy: vndbPublicTagTaxonomy('cont'),
                          code: 'g311',
                          id: conceptId,
                          type: 'skos:Concept',
                          schemeId,
                          releaseDigest: bundledDigest,
                        },
                      ]
                    : [],
                },
                rows: context.subjectId
                  ? [
                      {
                        kind: 'tag',
                        path: '/tags_vn/v123/g311/tag',
                        code: 'g311',
                        category: 'cont',
                        spoiler: 0,
                        subject: { id: context.subjectId, type: 'wd:Q689445', releaseDigest: bundledDigest },
                      },
                    ]
                  : [],
              },
            },
      );
    },
  };
  const f = await local(undefined, registration);
  try {
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    const before = f.importer.session.bindings.candidates({ source: 'vndb', external_id: 'v123' }, 'facts', {
      limit: 100,
    });
    f.calls.length = 0;
    conceptId = randomUUID();
    await f.reopen();
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    const proposed = f.calls.flatMap((request) => request.commands);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      op: 'propose',
      statement: { property: { id: 'schema:genre' }, value: { type: 'value', content: conceptId } },
    });
    const after = f.importer.session.bindings.candidates({ source: 'vndb', external_id: 'v123' }, 'facts', {
      limit: 100,
    });
    expect(after.map((candidate) => candidate.candidate)).toEqual(
      expect.arrayContaining(before.map((candidate) => candidate.candidate)),
    );
    f.calls.length = 0;
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    expect(f.calls).toEqual([]);
    conceptId = randomUUID();
    expect((await f.facade.commit(await f.stage())).status).toBe('committed');
    expect(
      f.calls
        .flatMap((request) => request.commands)
        .map((command) => command.op)
        .sort(),
    ).toEqual(['propose', 'retract']);
  } finally {
    await f.close();
  }
});
