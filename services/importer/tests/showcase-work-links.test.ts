import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { CrossMediaDumpFiles, crossMediaAliases, planCrossMediaSeed } from '../src/cross-media-seed.ts';
import { vndbWorkLinkConverterRevision } from '../src/showcase-work-links.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from '../src/vndb-tables.ts';

const VNDB_DUMP_TABLES = [
  'anime',
  'chars',
  'chars_vns',
  'entry_meta',
  'extlinks',
  'producers',
  'producers_relations',
  'producers_extlinks',
  'releases',
  'releases_extlinks',
  'releases_producers',
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
const VNDB_DUMP_HEADERS = {
  extlinks: ['id', 'site', 'value'],
  producers_relations: ['id', 'pid', 'relation'],
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
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
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
    vn_extlinks: 'v410\t99\nv411\t4\nv411\t2\nv411\t1\nv999\t3',
    extlinks:
      '1\twebsite\thttps://bgm.tv/subject/100\n2\twebsite\thttps://example.org/v411\n3\twebsite\thttps://bgm.tv/subject/100\n4\twikidata\thttps://bgm.tv/subject/101',
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
      vn_extlinks: [{ id: 'v411', link: 1 }, { id: 'v411', link: 2 }, { id: 'v411', link: 4 }],
      extlinks: [
        { id: 1, site: 'website', value: 'https://bgm.tv/subject/100' },
        { id: 2, site: 'website', value: 'https://example.org/v411' },
        { id: 4, site: 'wikidata', value: 'https://bgm.tv/subject/101' },
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
    ]);
    expect(plan.workLinks[2]?.bridgeReason).toContain('site does not admit');
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
    expect(urls).toEqual(['https://bgm.tv/subject/100', 'https://example.org/v411']);
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
