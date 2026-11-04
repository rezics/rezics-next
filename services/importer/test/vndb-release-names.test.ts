import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import { convertCrossMediaEntity } from '@rezics/conversion/cross-media-entities';
import { VNDB_DUMP_TABLES } from '../../../scripts/datasets/fetch-dumps.ts';
import { collectSelectedReleaseTitles, CrossMediaDumpFiles, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from '../tests/transport-driver.ts';
import { importVndbReleaseFidelity, planVndbReleaseFidelity } from '../src/vndb-release-fidelity.ts';

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(
  directory: string,
  titles = [
    'r9\ten\tf\tOther owner\t\\N',
    'r1\ten\tt\tHarbor Soft\t\\N',
    'r1\tja\tf\t港の題名\tMinato no Daimei',
    'r1\tja\tf\t港別題\t\\N',
  ],
  supersessions: readonly { id: string; rid: string }[] = [],
) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: ['id\treleased', 'r1\t20200229\nr2\t20200300'],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', titles.join('\n')],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr2\tv1\tcomplete'],
    releases_supersedes: ['id\trid', supersessions.map(({ id, rid }) => `${id}\t${rid}`).join('\n')],
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

test('acquisition requires releases_titles with a dump header', () => {
  expect(VNDB_DUMP_TABLES).toContain('releases_titles');
});

test('selected-family and date-fidelity planners bind only selected multilingual titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-names-'));
  try {
    const releaseTitles = [
      'r9\ten\tf\tOther owner\t\\N',
      'r1\ten\tt\tHarbor Soft\t\\N',
      'r1\tja\tf\t港の題名\tMinato no Daimei',
      'r1\tja\tf\t港別題\t\\N',
    ];
    const supersessions = [{ id: 'r1', rid: 'r2' }];
    const tables = await authoredCopy(directory, releaseTitles, supersessions);
    const fidelity = await planVndbReleaseFidelity(tables);
    const release = fidelity.entities.vndb.find((row) => row.key === 'r1');
    const missing = fidelity.entities.vndb.find((row) => row.key === 'r2');
    expect(release?.payload).toMatchObject({
      id: 'r1',
      releases_titles: [
        { id: 'r1', lang: 'en', mtl: 't', title: 'Harbor Soft', latin: null },
        { id: 'r1', lang: 'ja', mtl: 'f', title: '港の題名', latin: 'Minato no Daimei' },
        { id: 'r1', lang: 'ja', mtl: 'f', title: '港別題', latin: null },
      ],
    });
    expect(JSON.stringify(release?.payload)).not.toContain('Other owner');
    expect(missing?.payload).not.toHaveProperty('releases_titles');
    expect(fidelity.gaps.some((gap) => gap.reason === 'Missing selected VNDB release title')).toBe(true);
    expect(fidelity.edges.filter((edge) => edge.table === 'releases_supersedes')).toMatchObject([
      {
        holder: 'r1',
        target: 'r2',
        property: 'rezics:releaseSupersedes',
        record: { id: 'r1', rid: 'r2' },
        fields: ['releases_supersedes.id', 'releases_supersedes.rid'],
      },
    ]);
    const reversed = await planVndbReleaseFidelity(
      await authoredCopy(directory, [
        'r1\tja\tf\t港別題\t\\N',
        'r1\tja\tf\t港の題名\tMinato no Daimei',
        'r1\ten\tt\tHarbor Soft\t\\N',
        'r9\ten\tf\tOther owner\t\\N',
      ]),
    );
    expect(reversed.entities.vndb.find((row) => row.key === 'r1')?.payload).toEqual(release?.payload);
    expect(
      collectSelectedReleaseTitles('r1', [
        { id: 'r9', lang: 'en', title: 'Other owner', latin: null },
        { id: 'r1', lang: 'ja', title: '港別題', latin: null },
        { id: 'r1', lang: 'en', title: 'Harbor Soft', latin: null },
      ]).titles.map((row) => row.title),
    ).toEqual(['Harbor Soft', '港別題']);
    const converted = convertCrossMediaEntity({
      external_id: 'r1',
      record_revision: null,
      record: release!.payload,
    });
    if (converted.proposals[0]?.op !== 'create') throw new Error('Expected bootstrap');
    expect(converted.proposals[0].subject.labels).toEqual({ en: 'Harbor Soft', ja: '港の題名' });
    const commands: BatchCommand[] = [];
    const imported = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, releaseTitles, supersessions),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    });
    expect(imported.status === 'imported' || imported.status === 'imported-with-gaps').toBe(true);
    const proposed = commands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:name' &&
          JSON.stringify(content(command)) === JSON.stringify({ language: 'ja', text: '港の題名' }),
      ),
    ).toBe(true);
    const supersession = proposed.find((command) => command.statement.property.id === 'rezics:releaseSupersedes');
    expect(supersession?.source.external_id).toBe('r1');
    expect(supersession?.statement.value.type).toBe('value');
    expect(supersession?.statement.references.flatMap((reference) => reference.parts.map((part) => part.value.content)))
      .toContain('https://vndb.org/r1');
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:alternateName' &&
          JSON.stringify(content(command)) === JSON.stringify({ language: 'ja-Latn', text: 'Minato no Daimei' }),
      ),
    ).toBe(true);
    expect(JSON.stringify(commands)).not.toContain('Other owner');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
