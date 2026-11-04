import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { CrossMediaDumpFiles, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  decodeVndbReleased,
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
  importVndbReleaseFidelity,
  planVndbReleaseFidelity,
  readVndbReleaseBindings,
} from '../src/vndb-release-fidelity.ts';

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(directory: string, released = '20200229') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: [
      'id\treleased',
      [
        `r1\t${released}`,
        'r2\t20200300',
        'r3\t20200000',
        'r4\t99999999',
        'r5\t00000000',
        'r6\t\\N',
        'r7\t20210101',
      ].join('\n'),
    ],
    releases_titles: [
      'id\tlang\tmtl\ttitle\tlatin',
      [
        'r1\tja\tt\tAuthored exact release\t\\N',
        'r2\tja\tt\tAuthored month release\t\\N',
        'r3\tja\tt\tAuthored year release\t\\N',
        'r4\tja\tt\tAuthored TBA release\t\\N',
        'r5\tja\tt\tAuthored unknown release\t\\N',
        'r6\tja\tt\tAuthored absent release\t\\N',
        'r7\tja\tt\tAuthored unsupported completeness\t\\N',
      ].join('\n'),
    ],
    releases_media: ['id\tmedium\tqty', ''],
    releases_platforms: ['id\tplatform', ''],
    releases_vn: [
      'id\tvid\trtype',
      [
        'r1\tv1\tcomplete',
        'r2\tv1\tpartial',
        'r3\tv1\tcomplete',
        'r4\tv1\tcomplete',
        'r5\tv1\tcomplete',
        'r6\tv1\tcomplete',
        'r7\tv1\tbundle',
      ].join('\n'),
    ],
    releases_supersedes: ['id\trid', 'r1\tr2'],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

const schemeId = '00000000-0000-4000-8000-000000000098';
const statusId = '00000000-0000-4000-8000-000000000099';
const subjects: Record<string, object> = {
  [schemeId]: {
    subject: {
      id: schemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: developmentStatusSchemeUri } }] },
    },
  },
  [statusId]: {
    subject: {
      id: statusId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: developmentStatusConceptUri('1') } }],
        'skos:inScheme': [{ value: { content: schemeId } }],
      },
    },
  },
};

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
      const known = subjects[id];
      if (!known) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return known as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('operator plans authored VNDB COPY releases without mixing work and release grains and imports through the seed caller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-fidelity-'));
  try {
    const tables = await authoredCopy(directory);
    const plan = await planVndbReleaseFidelity(tables);
    expect(plan.records.vndb.map((row) => row.key)).toEqual(['v1']);
    expect(plan.entities.vndb.map((row) => row.key)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(plan.members.some((row) => row.key === 'v1' && row.kind === 'work')).toBe(true);
    expect(plan.members.filter((row) => row.kind === 'release')).toHaveLength(7);
    expect(plan.gaps.some((gap) => gap.reason.includes('supersession'))).toBe(true);
    expect(plan.edges.every((edge) => edge.property === 'schema:exampleOfWork')).toBe(true);
    expect(decodeVndbReleased('20200229')).toBe('2020-02-29');
    expect(decodeVndbReleased('20200300')).toBe('2020-03');
    expect(decodeVndbReleased('20200000')).toBe('2020');
    expect(decodeVndbReleased('99999999')).toBe('TBA');
    expect(decodeVndbReleased('00000000')).toBe('unknown');
    expect(decodeVndbReleased(null)).toBeNull();
    expect(plan.facts.releases.get('r1')?.links).toEqual([{ vid: 'v1', completeness: 'complete' }]);
    expect(plan.facts.releases.get('r2')?.links).toEqual([{ vid: 'v1', completeness: 'partial' }]);
    const commands: BatchCommand[] = [];
    const bindings = await readVndbReleaseBindings(port(commands), [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(bindings.concepts.map((item) => item.code)).toEqual(['1']);
    const first = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('"precision":10'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('"precision":9'),
      ),
    ).toBe(true);
    expect(
      proposed.some((command) => command.statement.property.id === 'schema:keywords' && content(command) === statusId),
    ).toBe(true);
    expect(proposed.some((command) => command.statement.property.id === 'schema:exampleOfWork')).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    const count = commands.length;
    const again = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    const changed: BatchCommand[] = [];
    const successor = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '20200301'),
      path: join(directory, 'state.sqlite'),
      port: port(changed),
      bindings,
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    expect(
      changed.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(
            command.statement.value.type === 'value' ? command.statement.value.content : undefined,
          ).includes('+2020-03-01T00:00:00Z'),
      ),
    ).toBe(true);
    subjects[statusId] = { subject: { id: statusId, type: 'skos:Concept', statements: {} } };
    const withheld = await readVndbReleaseBindings(port([]), [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(withheld.concepts).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
