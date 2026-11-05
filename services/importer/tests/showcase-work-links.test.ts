import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { vndbLimits } from '@rezics/conversion/vndb';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { CrossMediaDumpFiles, crossMediaAliases, planCrossMediaSeed } from '../src/cross-media-seed.ts';
import { vndbWorkLinkConverterRevision } from '../src/showcase-work-links.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from '../src/vndb-tables.ts';

const VNDB_DUMP_TABLES = [
  'anime',
  'chars',
  'chars_alias',
  'chars_names',
  'chars_vns',
  'entry_meta',
  'extlinks',
  'producers',
  'producers_relations',
  'producers_extlinks',
  'releases',
  'releases_extlinks',
  'releases_media',
  'releases_producers',
  'releases_platforms',
  'releases_supersedes',
  'releases_titles',
  'releases_vn',
  'staff',
  'staff_alias',
  'staff_extlinks',
  'tags',
  'tags_parents',
  'tags_vn',
  'vn',
  'vn_anime',
  'vn_extlinks',
  'vn_relations',
  'vn_seiyuu',
  'vn_staff',
  'vn_titles',
];
const VNDB_DUMP_HEADERS: Record<string, readonly string[]> = {
  extlinks: ['id', 'site', 'value'],
  chars: [
    'id',
    'image',
    'bloodt',
    'cup_size',
    'sex',
    'spoil_sex',
    'gender',
    'spoil_gender',
    'main',
    'main_spoil',
    's_bust',
    's_waist',
    's_hip',
    'birthday',
    'height',
    'weight',
    'age',
    'description',
  ],
  chars_alias: ['id', 'spoil', 'name', 'latin'],
  chars_names: ['id', 'lang', 'name', 'latin'],
  producers_relations: ['id', 'pid', 'relation'],
  releases_media: ['id', 'medium', 'qty'],
  releases_platforms: ['id', 'platform'],
  tags: VNDB_PUBLIC_TAG_COLUMNS.tags,
  tags_parents: VNDB_PUBLIC_TAG_COLUMNS.tags_parents,
  tags_vn: VNDB_PUBLIC_TAG_COLUMNS.tags_vn,
  vn_extlinks: ['id', 'link'],
};

async function copiedDumps(root: string) {
  const bangumi = join(root, 'bangumi');
  const vndb = join(root, 'vndb', 'db');
  await mkdir(bangumi, { recursive: true });
  await mkdir(vndb, { recursive: true });
  await writeFile(
    join(bangumi, 'subject.jsonlines'),
    [
      { id: 100, type: 2, name: 'STEINS;GATE' },
      { id: 101, type: 2, name: 'CLANNAD' },
      { id: 102, type: 2, name: 'Fate/stay night' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  for (const name of [
    'subject-relations',
    'subject-characters',
    'subject-persons',
    'character',
    'person',
    'person-characters',
    'person-relations',
    'episode',
  ])
    await writeFile(join(bangumi, `${name}.jsonlines`), '');

  const headers: Record<string, readonly string[]> = {
    vn: ['id', 'olang', 'alias'],
    vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
    entry_meta: ['id', 'revision', 'lastmod'],
    vn_extlinks: ['id', 'link'],
    extlinks: ['id', 'site', 'value'],
    tags: VNDB_PUBLIC_TAG_COLUMNS.tags,
    tags_vn: VNDB_PUBLIC_TAG_COLUMNS.tags_vn,
    tags_parents: VNDB_PUBLIC_TAG_COLUMNS.tags_parents,
  };
  const bodies: Record<string, string> = {
    vn: 'v410\tja\t\\N\nv411\tja\t\\N\nv412\tja\t\\N\nv413\tja\t\\N\nv999\tja\t\\N',
    vn_titles:
      'v410\tja\tt\tSTEINS;GATE\t\\N\nv411\tja\tt\tSTEINS;GATE 0\t\\N\nv412\tja\tt\tCLANNAD\t\\N\nv413\tja\tt\tFate/stay night\t\\N\nv999\tja\tt\tUnselected work\t\\N',
    entry_meta:
      'v410\t7\t2026-10-25 00:00:00+00\nv411\t8\t2026-10-25 00:00:00+00\nv412\t9\t2026-10-25 00:00:00+00\nv413\t10\t2026-10-25 00:00:00+00\nv999\t11\t2026-10-25 00:00:00+00',
    vn_extlinks: 'v410\t99\nv411\t4\nv411\t2\nv411\t1\nv411\t5\nv411\t6\nv999\t3',
    extlinks:
      '1\twebsite\thttps://bgm.tv/subject/100\n2\twebsite\thttps://example.org/v411\n3\twebsite\thttps://bgm.tv/subject/100\n4\twikidata\thttps://bgm.tv/subject/101\n5\twebsite\thttps://bgm.tv/character/9\n6\twebsite\thttps://bgm.tv/person/8',
  };
  for (const table of VNDB_DUMP_TABLES) {
    const header = headers[table] ?? VNDB_DUMP_HEADERS[table] ?? ['id'];
    await writeFile(join(vndb, `${table}.header`), `${header.join('\t')}\n`);
    await writeFile(join(vndb, table), bodies[table] ? `${bodies[table]}\n` : '');
  }
  return { bangumi, vndb: join(root, 'vndb') };
}

test('default selected-family COPY planning joins only selected VN links and keeps missing rows explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'showcase-work-links-'));
  try {
    const paths = await copiedDumps(root);
    expect(VNDB_DUMP_TABLES).toContain('vn_extlinks');
    expect(VNDB_DUMP_HEADERS.vn_extlinks).toEqual(['id', 'link']);
    expect(VNDB_DUMP_HEADERS.extlinks).toEqual(['id', 'site', 'value']);
    const plan = await planCrossMediaSeed(new CrossMediaDumpFiles(paths.bangumi, paths.vndb));
    const selected = plan.records.vndb.find((record) => record.key === 'v411')!;
    const missing = plan.records.vndb.find((record) => record.key === 'v410')!;
    expect(selected.payload).toMatchObject({
      vn_extlinks: [
        { id: 'v411', link: 1 },
        { id: 'v411', link: 2 },
        { id: 'v411', link: 4 },
        { id: 'v411', link: 5 },
        { id: 'v411', link: 6 },
      ],
      extlinks: [
        { id: 1, site: 'website', value: 'https://bgm.tv/subject/100' },
        { id: 2, site: 'website', value: 'https://example.org/v411' },
        { id: 4, site: 'wikidata', value: 'https://bgm.tv/subject/101' },
        { id: 5, site: 'website', value: 'https://bgm.tv/character/9' },
        { id: 6, site: 'website', value: 'https://bgm.tv/person/8' },
      ],
    });
    expect(missing.payload).not.toHaveProperty('vn_extlinks');
    expect(plan.gaps).toContainEqual(
      expect.objectContaining({
        source: 'vndb',
        fields: ['vn_extlinks.id', 'vn_extlinks.link'],
        record: { id: 'v410', link: 99 },
        reason: 'Selected VNDB work external-link dictionary row is missing',
      }),
    );
    expect(
      plan.workLinks.map(({ owner, linkId, bangumiExternalId }) => ({ owner, linkId, bangumiExternalId })),
    ).toEqual([
      { owner: 'v411', linkId: 1, bangumiExternalId: '100' },
      { owner: 'v411', linkId: 2, bangumiExternalId: undefined },
      { owner: 'v411', linkId: 4, bangumiExternalId: undefined },
      { owner: 'v411', linkId: 5, bangumiExternalId: undefined },
      { owner: 'v411', linkId: 6, bangumiExternalId: undefined },
    ]);
    expect(plan.workLinks[2]?.bridgeReason).toContain('site does not admit');
    expect(plan.workLinks.slice(3).every((link) => link.bridgeReason !== undefined)).toBe(true);
    expect(plan.edges.filter((item) => item.property === 'wdt:P5732')).toHaveLength(1);
    const linked = plan.workLinks[0]!;
    const edge = plan.edges.find((item) => item.property === 'wdt:P5732')!;
    expect(edge).toMatchObject({
      alias: crossMediaAliases.vndb,
      holder: 'v411',
      target: '100',
      url: 'https://bgm.tv/subject/100',
      table: 'extlinks',
      recordRevision: '8',
      converterRevision: vndbWorkLinkConverterRevision,
      fenceFacts: true,
      fields: ['vn_extlinks.id', 'vn_extlinks.link', 'extlinks.id', 'extlinks.site', 'extlinks.value'],
    });
    expect(edge.record).toEqual({
      vn_extlinks: { id: 'v411', link: '1' },
      extlinks: { id: '1', site: 'website', value: 'https://bgm.tv/subject/100' },
    });
    const registration = createSourceRegistration('vndb', {
      source: crossMediaAliases.vndb,
      converterRevision: entityRevision,
    });
    const converted = registration.convert(
      { external_id: selected.key, record_revision: selected.revision, record: selected.payload },
      { source: crossMediaAliases.vndb, subjectId: '00000000-0000-4000-8000-000000000411' },
    );
    const urls = converted.proposals.flatMap((command) =>
      command.op === 'propose' && command.statement.property.id === 'schema:url'
        ? [command.statement.value.type === 'value' ? command.statement.value.content : null]
        : [],
    );
    expect(urls).toEqual([
      'https://bgm.tv/subject/100',
      'https://example.org/v411',
      'https://bgm.tv/character/9',
      'https://bgm.tv/person/8',
    ]);
    expect(
      converted.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P5732'),
    ).toBe(false);
    expect(linked.candidateDigest).toBe(sourceDigest(edge.record));
    expect(linked.semanticDigest).toBe(
      sourceDigest({
        vn_extlinks: { id: 'v411', link: 1 },
        extlinks: { id: 1, site: 'website', value: 'https://bgm.tv/subject/100' },
      }),
    );
    expect(JSON.stringify(selected.payload)).not.toContain('v999');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required VNDB work-link tables reject corrupt headers and missing bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'showcase-work-links-invalid-'));
  try {
    const paths = await copiedDumps(root);
    await writeFile(join(paths.vndb, 'db', 'vn_extlinks.header'), 'id\twrong\n');
    await expect(planCrossMediaSeed(new CrossMediaDumpFiles(paths.bangumi, paths.vndb))).rejects.toThrow(
      'Invalid VNDB vn_extlinks header',
    );
    await writeFile(join(paths.vndb, 'db', 'vn_extlinks.header'), 'id\tlink\n');
    await rm(join(paths.vndb, 'db', 'vn_extlinks'));
    await expect(planCrossMediaSeed(new CrossMediaDumpFiles(paths.bangumi, paths.vndb))).rejects.toThrow(
      'Required VNDB external-link table is missing: vn_extlinks',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed and oversized selected work links stay atomic bounded gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'showcase-work-links-bounds-'));
  try {
    const paths = await copiedDumps(root);
    const extlinksPath = join(paths.vndb, 'db', 'extlinks');
    await writeFile(extlinksPath, '1\twebsite\tjavascript:alert(1)\n2\twebsite\thttps://example.org/v411\n');
    const malformed = await planCrossMediaSeed(new CrossMediaDumpFiles(paths.bangumi, paths.vndb));
    expect(malformed.gaps).toContainEqual(
      expect.objectContaining({
        source: 'vndb',
        fields: ['extlinks.id', 'extlinks.site'],
        record: { id: 1, site: 'website' },
        reason: 'Invalid external website URL; omitted from native facts',
      }),
    );
    expect(malformed.workLinks.some((link) => link.owner === 'v411' && link.linkId === 1)).toBe(false);
    expect(malformed.edges.some((edge) => edge.holder === 'v411' && edge.property === 'wdt:P5732')).toBe(false);

    const oversizedJoins = Array.from({ length: vndbLimits.maxLinks + 1 }, (_, index) => `v411\t${index + 1}`).join(
      '\n',
    );
    await writeFile(join(paths.vndb, 'db', 'vn_extlinks'), `${oversizedJoins}\n`);
    await writeFile(
      extlinksPath,
      Array.from(
        { length: vndbLimits.maxLinks + 1 },
        (_, index) => `${index + 1}\twebsite\thttps://example.org/${index + 1}`,
      ).join('\n') + '\n',
    );
    const oversized = await planCrossMediaSeed(new CrossMediaDumpFiles(paths.bangumi, paths.vndb));
    expect(oversized.gaps).toContainEqual(
      expect.objectContaining({
        source: 'vndb',
        fields: ['vn_extlinks.id', 'vn_extlinks.link'],
        record: { id: 'v411', link: vndbLimits.maxLinks + 1 },
        reason: 'Selected VNDB work external links exceed the converter limit',
      }),
    );
    expect(oversized.records.vndb.find((record) => record.key === 'v411')?.payload).not.toHaveProperty('vn_extlinks');
    expect(oversized.workLinks.some((link) => link.owner === 'v411')).toBe(false);
    expect(oversized.edges.some((edge) => edge.holder === 'v411' && edge.property === 'wdt:P5732')).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
