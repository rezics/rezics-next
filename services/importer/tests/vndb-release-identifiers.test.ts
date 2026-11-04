import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  converter_revision,
  convertCrossMediaEntity,
  decodeVndbReleaseGtin,
} from '@rezics/conversion/cross-media-entities';
import { CrossMediaDumpFiles, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { importVndbReleaseIdentifiers, planVndbReleaseIdentifiers } from '../src/vndb-release-identifiers.ts';

const supported = '4580123456789';
const changed = '4901234567894';
const subjectId = '00000000-0000-4000-8000-000000000004';

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(directory: string, gtin = supported) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N\nv2\tja\t0\t\\N'],
    vn_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      'v1\tja\tt\tAuthored work\t\\N\nv2\tja\tt\tAuthored companion\t\\N',
    ],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00'],
    releases: [
      'id\tgtin\treleased',
      [`r1\t${gtin}\t20200229`, 'r2\t0\t20200300', 'r3\t12a\t20200401', 'r4\t12345\t20200501', 'r5\t\\N\t20200601'].join(
        '\n',
      ),
    ],
    releases_titles: [
      'id\tlang\tmtl\ttitle\tlatin',
      [
        'r1\tja\tt\tAuthored barcode release\t\\N',
        'r2\tja\tt\tAuthored unknown barcode\t\\N',
        'r3\tja\tt\tAuthored malformed barcode\t\\N',
        'r4\tja\tt\tAuthored short barcode\t\\N',
        'r5\tja\tt\tAuthored absent barcode\t\\N',
      ].join('\n'),
    ],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tcomplete\nr2\tv1\tcomplete\nr3\tv1\tcomplete\nr4\tv1\tcomplete\nr5\tv1\tcomplete'],
    releases_supersedes: ['id\trid', ''],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id, type: id.startsWith('r') ? 'wd:Q20631656' : 'wd:Q689445' } };
    },
  };
}

function gtinFacts(commands: BatchCommand[], externalId: string) {
  return commands.filter(
    (command) =>
      command.op === 'propose' &&
      command.source.external_id === externalId &&
      command.statement.property.id === 'schema:gtin',
  );
}

test('operator COPY import preserves a supported release GTIN, withholds unknown and invalid cells, and refreshes through one identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-identifiers-'));
  try {
    const tables = await authoredCopy(directory);
    const plan = await planVndbReleaseIdentifiers(tables);
    const payload = (id: string) => plan.entities.vndb.find((row) => row.key === id)?.payload as Record<string, unknown>;
    expect(payload('r1')).toMatchObject({ id: 'r1', gtin: supported });
    expect(payload('r2').gtin).toBe('0');
    expect(payload('r3').gtin).toBe('12a');
    expect(payload('r4').gtin).toBe('12345');
    expect(payload('r5').gtin).toBeNull();
    expect(plan.facts.releases.get('r1')?.links).toEqual([
      { vid: 'v1', completeness: 'complete' },
      { vid: 'v2', completeness: 'complete' },
    ]);
    const bound = (id: string, extra: Record<string, unknown> = {}) =>
      convertCrossMediaEntity(
        { external_id: id, record_revision: null, record: { ...payload(id), ...extra } },
        { subjectId },
      );
    const admitted = bound('r1');
    expect(converter_revision).not.toBe('cross-media-entities@3');
    expect(admitted.converter_revision).toBe(converter_revision);
    expect(admitted.normalizedRecord.gtin).toBe(supported);
    expect(decodeVndbReleaseGtin(admitted.normalizedRecord.gtin)).toEqual({ status: 'admitted', gtin: supported });
    expect(gtinFacts([...admitted.proposals], 'r1')).toHaveLength(1);
    expect(gtinFacts([...admitted.proposals], 'r1')[0]?.statement.value).toEqual({ type: 'value', content: supported });
    expect(gtinFacts([...admitted.proposals], 'r1')[0]?.source.field_group).toBe('facts');
    expect(bound('r2').diagnostics).toContainEqual({ pointer: '/gtin', code: 'unknown_source_value' });
    expect(gtinFacts([...bound('r2').proposals], 'r2')).toEqual([]);
    expect(bound('r3').diagnostics).toContainEqual({ pointer: '/gtin', code: 'invalid_source_value' });
    expect(bound('r4').diagnostics).toContainEqual({ pointer: '/gtin', code: 'invalid_source_value' });
    expect(bound('r5').diagnostics.filter((item) => item.pointer === '/gtin')).toEqual([]);
    expect(gtinFacts([...bound('r5').proposals], 'r5')).toEqual([]);
    const unsafe = bound('r1', { gtin: Number.MAX_SAFE_INTEGER + 2 });
    expect(unsafe.normalizedRecord.gtin).toBe(Number.MAX_SAFE_INTEGER + 2);
    expect(unsafe.diagnostics).toContainEqual({ pointer: '/gtin', code: 'invalid_source_value' });
    expect(gtinFacts([...unsafe.proposals], 'r1')).toEqual([]);
    const stamped = convertCrossMediaEntity(
      { external_id: 'r1', record_revision: null, record: payload('r1') },
      { subjectId },
      { converterRevision: 'cross-media-entities@3' },
    );
    expect(stamped.digest).toBe(admitted.digest);
    expect(gtinFacts([...stamped.proposals], 'r1')[0]?.key).not.toBe(gtinFacts([...admitted.proposals], 'r1')[0]?.key);
    const firstCommands: BatchCommand[] = [];
    const path = join(directory, 'state.sqlite');
    const bindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
    const first = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory),
      path,
      port: port(firstCommands),
      bindings,
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(gtinFacts(firstCommands, 'r1')).toHaveLength(1);
    expect(gtinFacts(firstCommands, 'r2')).toEqual([]);
    expect(gtinFacts(firstCommands, 'r3')).toEqual([]);
    expect(gtinFacts(firstCommands, 'r4')).toEqual([]);
    expect(gtinFacts(firstCommands, 'r5')).toEqual([]);
    const creates = firstCommands.filter((command) => command.op === 'create' && command.source.external_id === 'r1');
    expect(creates).toHaveLength(1);
    const refreshCommands: BatchCommand[] = [];
    const refresh = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory),
      path,
      port: port(refreshCommands),
      bindings,
    });
    expect(refresh.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(gtinFacts(refreshCommands, 'r1')).toEqual([]);
    const changedCommands: BatchCommand[] = [];
    const successor = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory, changed),
      path,
      port: port(changedCommands),
      bindings,
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    expect(gtinFacts(changedCommands, 'r1')[0]?.statement.value).toEqual({ type: 'value', content: changed });
    expect(gtinFacts(changedCommands, 'r1')[0]?.key).not.toBe(gtinFacts(firstCommands, 'r1')[0]?.key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
