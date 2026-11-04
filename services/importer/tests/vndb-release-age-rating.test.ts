import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '@rezics/conversion';
import { convertCrossMediaEntity, converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { CrossMediaDumpFiles, crossMediaAliases, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { Importer } from '../src/importer.ts';
import type { ImportTransport, SourceRegistration } from '../src/import-contract.ts';
import { importVndbReleaseFidelity, planVndbReleaseFidelity, readVndbReleaseBindings } from '../src/vndb-release-fidelity.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

async function authoredCopy(directory: string, age = '15') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t\\N\t\\N\nv2\tja\t\\N\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work one\t\\N\nv2\tja\tt\tAuthored work two\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00'],
    releases: ['id\treleased\tminage', `r1\t\\N\t${age}\nr2\t\\N\t0\nr3\t\\N\t\\N\nr4\t\\N\t-1\nr5\t\\N\t15.5\nr6\t\\N\t19`],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => `${id}\tja\tt\tAuthored ${id}\t\\N`).join('\n')],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tpartial\nr2\tv1\tcomplete\nr3\tv1\tcomplete\nr4\tv1\tcomplete\nr5\tv1\tcomplete\nr6\tv1\tcomplete'],
    releases_supersedes: ['id\trid', ''],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

function transport(
  commands: BatchCommand[],
  ids: Map<string, string>,
  receipts: Map<string, BatchWriteResult['results'][number]>,
): ImportTransport {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batchWrite(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          const old = receipts.get(command.key);
          if (old) return structuredClone(old);
          let value:
            | { id: string; revision: number }
            | { candidate: string; revision: number }
            | { revision: number };
          if (command.op === 'create') {
            let id = ids.get(command.source.external_id);
            if (!id) ids.set(command.source.external_id, (id = randomUUID()));
            value = { id, revision: 1 };
          } else value = command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 };
          const result = { key: command.key, status: 201 as const, value };
          receipts.set(command.key, result);
          return structuredClone(result);
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
  };
}

function port(
  commands: BatchCommand[],
  ids: Map<string, string>,
  receipts: Map<string, BatchWriteResult['results'][number]>,
): CrossMediaPort {
  const api = transport(commands, ids, receipts);
  return {
    batch: api.batchWrite,
    setSourceRecordMetadata: api.setSourceRecordMetadata!,
    async fence(tuple) {
      return api.readFence({ source: tuple.source, external_id: tuple.externalId, field_group: tuple.fieldGroup });
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

async function* records(rows: SourceRecord[]) {
  yield* rows;
}

test('operator refreshes unchanged VNDB COPY releases with explicit age while retaining release identity and source values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-age-'));
  const commands: BatchCommand[] = [];
  const ids = new Map<string, string>();
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  const path = join(directory, 'state.sqlite');
  try {
    const tables = await authoredCopy(directory);
    const plan = await planVndbReleaseFidelity(tables);
    const current = createSourceRegistration('vndb', {
      source: crossMediaAliases.vndb,
      converterRevision: entityRevision,
    });
    const release = plan.entities.vndb.find((row) => row.key === 'r1')!;
    const bindings = await readVndbReleaseBindings(port([], ids, receipts), []);
    const projected = current.convert(
      { external_id: release.key, record_revision: 'unversioned', record: release.payload },
      { source: crossMediaAliases.vndb },
    ).normalized as Record<string, unknown>;
    expect(projected.minage).toBe('15');
    const kana = current.convert(
      { external_id: 'r99', record_revision: '7', record: { id: 'r99', minage: 15 } },
      { source: crossMediaAliases.vndb, subjectId: '11111111-1111-4111-8111-111111111111' },
    );
    expect(kana.proposals.some((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P2899')).toBe(true);

    const previousRevision = 'cross-media-entities@5';
    const legacy: SourceRegistration = {
      ...current,
      converter_revision: previousRevision,
      convert(input, context) {
        const { minage: _omitted, ...record } = input.record as Record<string, unknown>;
        const result = convertCrossMediaEntity(
          { ...input, record },
          context,
          { converterRevision: previousRevision, sourceKind: 'vndb' },
        );
        return { ...result, normalized: result.normalizedRecord };
      },
    };
    const oldImporter = new Importer({ path, transport: transport(commands, ids, receipts) });
    const oldResult = await oldImporter.runRecords(legacy, records(plan.entities.vndb));
    if (oldResult.status !== 'committed') throw new Error(`${oldResult.status}: ${oldResult.diagnostic}`);
    await oldImporter.close();
    const previousReceipts = JSON.stringify(commands);
    const previousCount = commands.length;

    const refreshed = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: port(commands, ids, receipts),
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(JSON.stringify(commands.slice(0, previousCount))).toBe(previousReceipts);
    const isAge = (command: BatchCommand): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'wdt:P2899';
    const ages = commands.filter(isAge);
    const content = (command: (typeof ages)[number]) => command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(ages.map((command) => [command.source.external_id, content(command)])).toEqual([
      ['r1', { amount: '+15', unit: 'http://www.wikidata.org/entity/Q577' }],
      ['r2', { amount: '+0', unit: 'http://www.wikidata.org/entity/Q577' }],
    ]);
    expect(ages.every((command) => command.source.record_revision === 'unversioned')).toBe(true);
    const idOf = (row: (typeof refreshed.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const releaseId = idOf(refreshed.readings.find((row) => row.externalId === 'r1')!);
    expect(releaseId).toBe(ids.get('r1'));
    expect(refreshed.gaps.some((gap) => gap.fields.includes('minage'))).toBe(false);

    const changed = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '16'),
      path,
      port: port(commands, ids, receipts),
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(idOf(changed.readings.find((row) => row.externalId === 'r1')!)).toBe(releaseId);
    expect(commands.some((command) => isAge(command) && command.source.external_id === 'r1' && JSON.stringify(command.statement.value).includes('+16'))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
