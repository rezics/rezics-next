import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { converter_revision, convertCrossMediaEntity } from '@rezics/conversion/cross-media-entities';
import { VNDB_DUMP_TABLES } from '../../../scripts/datasets/fetch-dumps.ts';
import { CrossMediaDumpFiles, planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';

function familyTables(extra: Record<string, Record<string, unknown>[]> = {}): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', title: 'STEINS;GATE', official: 't', lang: 'en', latin: null },
      { id: 'v2', title: 'CLANNAD', official: 't', lang: 'en', latin: null },
      { id: 'v3', title: 'Fate/stay night', official: 't', lang: 'en', latin: null },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'en' },
      { id: 'v2', olang: 'en' },
      { id: 'v3', olang: 'en' },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1' },
      { id: 'v2', revision: '1' },
      { id: 'v3', revision: '1' },
    ],
    'vndb/vn_staff': [{ id: 'v1', aid: '10', role: 'scenario' }],
    'vndb/staff_alias': [{ id: 's4', aid: '10', name: 'Authored staff' }],
    'vndb/staff': [{ id: 's4', main: '10', prod: null }],
    'vndb/releases': [{ id: 'r1', title: 'Authored release' }],
    'vndb/releases_vn': [{ id: 'r1', vid: 'v1', rtype: 'complete' }],
    'vndb/releases_producers': [{ id: 'r1', pid: 'p1', developer: 't', publisher: 'f' }],
    'vndb/producers': [
      { id: 'p1', type: 'co', name: 'Authored producer' },
      { id: 'p9', type: 'co', name: 'Unselected producer' },
    ],
    'vndb/staff_extlinks': [
      { id: 's4', link: 1 },
      { id: 's4', link: 2 },
    ],
    'vndb/producers_extlinks': [
      { id: 'p1', link: 1 },
      { id: 'p9', link: 5 },
    ],
    'vndb/releases_extlinks': [{ id: 'r1', link: 4 }],
    'vndb/vn_extlinks': [{ id: 'v1', link: 8 }],
    'vndb/extlinks': [
      { id: 1, site: 'website', value: 'https://example.org/shared' },
      { id: 2, site: 'website', value: 'https://example.org/staff' },
      { id: 4, site: 'website', value: 'https://example.org/release' },
      { id: 5, site: 'website', value: 'https://example.org/unselected' },
      { id: 6, site: 'wikidata', value: 'Q1' },
      { id: 8, site: 'website', value: 'https://bgm.tv/subject/1' },
    ],
    ...extra,
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

test('production seed joins selected staff, producer and release websites without reusing vnLinks as uniqueness', async () => {
  expect(VNDB_DUMP_TABLES).toEqual(
    expect.arrayContaining(['staff_extlinks', 'producers_extlinks', 'releases_extlinks']),
  );
  const plan = await planCrossMediaSeed(familyTables());
  const staff = plan.entities.vndb.find((row) => row.key === 's4')!;
  const producer = plan.entities.vndb.find((row) => row.key === 'p1')!;
  const release = plan.entities.vndb.find((row) => row.key === 'r1')!;
  const unselected = plan.entities.vndb.find((row) => row.key === 'p9');
  expect(unselected).toBeUndefined();
  expect(staff.payload).toMatchObject({
    staff_extlinks: [
      { id: 's4', link: 1 },
      { id: 's4', link: 2 },
    ],
    extlinks: [
      { id: 1, site: 'website', value: 'https://example.org/shared' },
      { id: 2, site: 'website', value: 'https://example.org/staff' },
    ],
  });
  expect(producer.payload).toMatchObject({
    producers_extlinks: [{ id: 'p1', link: 1 }],
    extlinks: [{ id: 1, site: 'website', value: 'https://example.org/shared' }],
  });
  expect(release.payload).toMatchObject({
    releases_extlinks: [{ id: 'r1', link: 4 }],
    extlinks: [{ id: 4, site: 'website', value: 'https://example.org/release' }],
  });
  expect(JSON.stringify(staff.payload)).not.toContain('unselected');
  expect(JSON.stringify(producer.payload)).not.toContain('unselected');
  expect(plan.edges.some((edge) => edge.property === 'wdt:P5732' && edge.holder === 'v1' && edge.target === '1')).toBe(
    true,
  );
  const bound = { source: 'vndb', subjectId: '00000000-0000-4000-8000-000000000001' };
  const staffConverted = convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: staff.payload },
    bound,
  );
  expect(staffConverted.converter_revision).toBe(converter_revision);
  expect(
    staffConverted.proposals.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:url',
    ),
  ).toHaveLength(2);
  const withoutLinks = convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: { id: 's4', name: 'Authored staff' } },
    bound,
  );
  expect(withoutLinks.digest).not.toBe(staffConverted.digest);
  expect(
    withoutLinks.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:url',
    ),
  ).toBe(false);
});

test('an explicit development selection keeps only its works and refuses a missing required root', async () => {
  const plan = await planCrossMediaSeed(familyTables(), { bangumi: [1, 2], vndb: ['v1', 'v2'] });
  expect(plan.records.bangumi.map((row) => row.key)).toEqual(['1', '2']);
  expect(plan.records.vndb.map((row) => row.key)).toEqual(['v1', 'v2']);
  await expect(planCrossMediaSeed(familyTables(), { bangumi: [99], vndb: ['v1'] })).rejects.toThrow(
    'Missing selected Bangumi work: 99',
  );
});

test('invalid optional website citations do not discard valid links or stop the selected family', async () => {
  const plan = await planCrossMediaSeed(
    familyTables({
      'vndb/extlinks': [
        { id: 1, site: 'website', value: 'https://example.org/shared' },
        { id: 2, site: 'website', value: 'http://example.org/legacy' },
        { id: 4, site: 'website', value: 'https://example.org/release' },
        { id: 8, site: 'website', value: 'https://example.org:443/explicit-port' },
      ],
    }),
  );
  expect(plan.entities.vndb.find((row) => row.key === 's4')?.payload).toMatchObject({
    staff_extlinks: [{ id: 's4', link: 1 }],
    extlinks: [{ id: 1, site: 'website', value: 'https://example.org/shared' }],
  });
  expect(plan.records.vndb.find((row) => row.key === 'v1')?.payload).not.toHaveProperty('extlinks');
  expect(
    plan.gaps
      .filter((gap) => gap.reason === 'Invalid external website URL; omitted from native facts')
      .map((gap) => gap.record.id),
  ).toEqual([2, 8]);
});

test('COPY headers keep integer link keys, overflow fails, and unsupported sites stay diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-entity-websites-copy-'));
  try {
    const bangumi = join(directory, 'bangumi');
    const db = join(directory, 'db');
    await mkdir(bangumi, { recursive: true });
    await mkdir(db, { recursive: true });
    await writeFile(
      join(bangumi, 'subject.jsonlines'),
      [
        '{"id":1,"type":2,"name":"STEINS;GATE"}',
        '{"id":2,"type":2,"name":"CLANNAD"}',
        '{"id":3,"type":2,"name":"Fate/stay night"}',
      ].join('\n') + '\n',
    );
    for (const table of [
      'subject-relations',
      'subject-characters',
      'subject-persons',
      'person-characters',
      'person-relations',
      'character',
      'person',
      'episode',
    ])
      await writeFile(join(bangumi, `${table}.jsonlines`), '');
    const files: Record<string, [string, string]> = {
      vn: ['id\tolang', 'v1\ten\nv2\ten\nv3\ten'],
      vn_titles: [
        'id\tlang\tofficial\ttitle\tlatin',
        'v1\ten\tt\tSTEINS;GATE\t\\N\nv2\ten\tt\tCLANNAD\t\\N\nv3\ten\tt\tFate/stay night\t\\N',
      ],
      entry_meta: ['id\trevision', 'v1\t1\nv2\t1\nv3\t1'],
      vn_staff: ['id\taid\trole', 'v1\t10\tscenario'],
      staff_alias: ['id\taid\tname', 's4\t10\tAuthored staff'],
      staff: ['id\tmain\tprod', 's4\t10\t\\N'],
      releases: ['id\ttitle', 'r1\tAuthored release'],
      releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete'],
      releases_producers: ['id\tpid\tdeveloper\tpublisher', 'r1\tp1\tt\tf'],
      producers: ['id\ttype\tname', 'p1\tco\tAuthored producer'],
      producers_relations: ['id\tpid\trelation', ''],
      staff_extlinks: ['id\tlink', 's4\t1\ns4\t6'],
      producers_extlinks: ['id\tlink', 'p1\t1'],
      releases_extlinks: ['id\tlink', ''],
      vn_extlinks: ['id\tlink', ''],
      vn_relations: ['id\tvid\trelation', ''],
      vn_seiyuu: ['id\tcid\taid\tnote', ''],
      chars_vns: ['id\tvid\trole', ''],
      chars: ['id\tname', ''],
      chars_names: ['id\tlang\tname\tlatin', ''],
      chars_alias: ['id\tspoil\tname\tlatin', ''],
      vn_anime: ['id\taid', ''],
      releases_supersedes: ['id\trid', ''],
      releases_titles: ['id\ttitle', ''],
      anime: ['id\ttitle', ''],
      extlinks: ['id\tsite\tvalue', '1\twebsite\thttps://example.org/shared\n6\twikidata\tQ1'],
    };
    for (const [name, [header, body]] of Object.entries(files)) {
      await writeFile(join(db, `${name}.header`), `${header}\n`);
      await writeFile(join(db, name), body ? `${body}\n` : '');
    }
    const plan = await planCrossMediaSeed(new CrossMediaDumpFiles(bangumi, directory));
    const staff = plan.entities.vndb.find((row) => row.key === 's4')!;
    expect(staff.payload).toMatchObject({
      staff_extlinks: [
        { id: 's4', link: 1 },
        { id: 's4', link: 6 },
      ],
      extlinks: [
        { id: 1, site: 'website', value: 'https://example.org/shared' },
        { id: 6, site: 'wikidata', value: 'Q1' },
      ],
    });
    const converted = convertCrossMediaEntity(
      { external_id: 's4', record_revision: null, record: staff.payload },
      { source: 'vndb', subjectId: '00000000-0000-4000-8000-000000000001' },
    );
    expect(
      converted.proposals.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:url' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === 'https://example.org/shared',
      ),
    ).toBe(true);
    expect(converted.diagnostics).toEqual([
      { pointer: '/extlinks/1/site', code: 'Unsupported external link site; retained as source metadata only' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const overflow = familyTables({
    'vndb/staff_extlinks': Array.from({ length: 33 }, (_, i) => ({ id: 's4', link: i + 1 })),
    'vndb/extlinks': Array.from({ length: 33 }, (_, i) => ({
      id: i + 1,
      site: 'website',
      value: `https://example.org/${i + 1}`,
    })),
  });
  await expect(planCrossMediaSeed(overflow)).rejects.toThrow();
  const missing = familyTables({
    'vndb/staff_extlinks': [{ id: 's4', link: 99 }],
  });
  expect(
    (await planCrossMediaSeed(missing)).gaps.some(
      (gap) => gap.reason === 'Missing selected VNDB external-link dictionary row',
    ),
  ).toBe(true);
  const unresolvedOwner = familyTables({
    'vndb/staff_extlinks': [{ id: 's99', link: 7 }],
    'vndb/extlinks': [{ id: 7, site: 'website', value: 'https://example.org/unresolved' }],
  });
  const unresolvedPlan = await planCrossMediaSeed(unresolvedOwner);
  expect(unresolvedPlan.entities.vndb.some((row) => row.key === 's99')).toBe(false);
  expect(unresolvedPlan.entities.vndb.find((row) => row.key === 's4')?.payload).not.toMatchObject({
    extlinks: [{ id: 7, value: 'https://example.org/unresolved' }],
  });
});
