import { expect, test } from 'bun:test';
import { decodeCopyCell, fateTitle, selectFate, VndbDump } from '../../../scripts/datasets/vndb.ts';

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content),
      header = Buffer.alloc(512);
    header.write(name);
    header.write(bytes.length.toString(8).padStart(11, '0'), 124);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const emptyHeaders: Record<string, string[]> = {
  vn: ['id', 'image', 'c_image', 'olang', 'alias', 'description'],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  vn_relations: ['id', 'vid', 'relation', 'official'],
  releases: ['id', 'olang', 'released', 'engine'],
  releases_vn: ['id', 'vid', 'rtype'],
  releases_supersedes: ['id', 'rid'],
  releases_titles: ['id', 'lang', 'title'],
  releases_producers: ['id', 'pid', 'developer', 'publisher'],
  releases_drm: ['id', 'drm'],
  releases_extlinks: ['id', 'link'],
  releases_images: ['id', 'img', 'vid', 'itype'],
  releases_media: ['id', 'medium', 'qty'],
  releases_platforms: ['id', 'platform'],
  chars: ['id', 'main', 'image', 'description'],
  chars_vns: ['id', 'vid', 'rid', 'role', 'spoil'],
  chars_names: ['id', 'lang', 'name'],
  chars_alias: ['id', 'name'],
  chars_traits: ['id', 'tid', 'spoil', 'lie'],
  vn_seiyuu: ['id', 'cid', 'aid', 'note'],
  vn_staff: ['id', 'aid', 'role', 'note'],
  staff: ['id', 'lang', 'main', 'prod'],
  staff_alias: ['id', 'aid', 'name', 'latin'],
  staff_extlinks: ['id', 'link'],
  producers: ['id', 'lang', 'name'],
  producers_relations: ['id', 'pid', 'relation'],
  producers_extlinks: ['id', 'link'],
  tags: ['id', 'name'],
  tags_parents: ['id', 'parent', 'main'],
  tags_vn: ['tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore'],
  traits: ['id', 'gid', 'name'],
  traits_parents: ['id', 'parent', 'main'],
  vn_anime: ['id', 'aid'],
  vn_editions: ['id', 'eid'],
  vn_extlinks: ['id', 'link'],
  vn_screenshots: ['id', 'scr', 'rid'],
  vn_image_votes: ['vid', 'uid', 'img'],
  vn_length_votes: ['vid', 'uid', 'length'],
  quotes: ['id', 'vid', 'cid', 'quote'],
  anime: ['id', 'title_romaji'],
  drm: ['id', 'name'],
  engines: ['id', 'name'],
  extlinks: ['id', 'site', 'value'],
  wikidata: ['id', 'enwiki'],
  images: ['id', 'width', 'height'],
  image_votes: ['id', 'uid', 'sexual'],
  entry_meta: ['id', 'revision'],
};
function dump(tables: Record<string, string[]>, headers = emptyHeaders): VndbDump {
  return new VndbDump(
    tar(
      Object.fromEntries(
        Object.entries(headers).flatMap(([name, columns]) => [
          [`db/${name}.header`, `${columns.join('\t')}\n`],
          [`db/${name}`, tables[name]?.join('\n') ?? ''],
        ]),
      ),
    ),
  );
}

test('VNDB COPY decoding preserves nulls, literal escapes, arrays, Unicode and escaped controls', () => {
  expect(decodeCopyCell('\\N')).toBeNull();
  expect(decodeCopyCell('\\\\N')).toBe('\\N');
  expect(decodeCopyCell('奈須\\tきのこ\\nline\\rreturn\\134\\x21')).toBe(
    '奈須\tきのこ\nline\rreturn\\!',
  );
  expect(decodeCopyCell('{en,ja}')).toBe('{en,ja}');
  const parsed = dump(
    { sample: ['v11\tFate\\tStay\\nNight\t\\N'] },
    { sample: ['id', 'title', 'missing'] },
  );
  expect([...parsed.rows('sample')]).toEqual([
    { id: 'v11', title: 'Fate\tStay\nNight', missing: null },
  ]);
  expect([...parsed.rows('sample', { column: 'id', values: new Set(['v12']) })]).toEqual([]);
  expect(() => [...parsed.rows('sample', { column: 'unknown', values: new Set() })]).toThrow(
    'Missing VNDB column',
  );
  expect(() => [...dump({ sample: ['v11\textra'] }, { sample: ['id'] }).rows('sample')]).toThrow(
    'column count',
  );
  expect(() => new VndbDump(tar({ '../escape': 'data' }))).toThrow('Unsafe');
  expect(() => new VndbDump(tar({ sample: 'data' }).subarray(0, 513))).toThrow('Truncated');
});

test('Fate brand discovery accepts native names/aliases without generic unrelated Fate titles', () => {
  for (const title of [
    'Fate/stay night',
    'FATE／EXTRA',
    'フェイト/エクストラ',
    'Fate Grand Order',
    'FGO',
  ])
    expect(fateTitle(title)).toBe(true);
  for (const title of [
    'Fate of the Foxes',
    'FATE MANIPULATION',
    'Fate King',
    'The Fate/Answer',
    null,
  ])
    expect(fateTitle(title)).toBe(false);
});

test('official series/parent/original links expand the family while cross-franchise character links stay references', () => {
  for (const relation of [
    'preq',
    'seq',
    'side',
    'set',
    'alt',
    'ser',
    'par',
    'orig',
    'char',
    'fan',
  ]) {
    const source = selectFate(
      dump({
        vn: ['v11\t\\N\t\\N\tja\tFGO\tBase', 'v2\t\\N\t\\N\tja\t\tRelated'],
        vn_titles: [
          'v11\tja\tt\tAlias-only original\t\\N',
          'v2\tja\tt\tUnprefixed related title\t\\N',
        ],
        vn_relations: [`v11\tv2\t${relation}\tt`],
      }),
    );
    expect(source.roots).toEqual(['vndb:vn:v11']);
    expect(source.scope.family).toEqual(
      relation === 'char' || relation === 'fan' ? ['v11'] : ['v11', 'v2'],
    );
    expect(source.records.some((record) => record.key === 'vndb:vn:v2')).toBe(true);
  }
});

test('Fate selection retains complete release bundles, character versions, credits, tag votes/ancestors, links and images', () => {
  const source = selectFate(
    dump({
      vn: [
        'v11\tcv1\tcv1\tja\t\tA\\nB',
        'v2\t\\N\t\\N\tja\t\tBonus',
        'v3\t\\N\t\\N\ten\t\tOther',
        'v4\t\\N\t\\N\tja\t\tCameo',
      ],
      vn_titles: [
        'v11\tja\tt\tFate/stay night\t\\N',
        'v2\tja\tt\tBonus disc\t\\N',
        'v3\ten\tt\tOther world\t\\N',
        'v4\tja\tt\tCameo world\t\\N',
      ],
      vn_relations: ['v11\tv2\tside\tt', 'v11\tv3\tchar\tt'],
      releases: ['r1\tja\t20040130\t1', 'r2\ten\t20089999\t\\N', 'r3\tja\t0\t\\N'],
      releases_vn: ['r1\tv11\tcomplete', 'r1\tv3\ttrial', 'r2\tv11\tcomplete', 'r3\tv4\tcomplete'],
      releases_supersedes: ['r1\tr2'],
      releases_producers: ['r1\tp1\tt\tt'],
      releases_platforms: ['r1\twin', 'r1\tlin'],
      releases_titles: ['r1\tja\tOriginal release', 'r2\ten\tEnglish release'],
      releases_drm: ['r1\t1'],
      releases_images: ['r1\tcv2\t\\N\tpkgfront'],
      chars: ['c1\tc2\tch1\tCharacter', 'c2\t\\N\t\\N\tOriginal version'],
      chars_names: ['c1\tja\tセイバー', 'c2\ten\tOriginal'],
      chars_vns: ['c1\tv11\tr1\tmain\t0', 'c1\tv4\tr3\tappears\t2'],
      chars_traits: ['c1\ti1\t2\tf'],
      traits: ['i1\ti2\tKnight', 'i2\t\\N\tGroup', 'i3\t\\N\tParent'],
      traits_parents: ['i1\ti3\tt'],
      vn_staff: ['v11\t1\tscenario\tAll routes'],
      vn_seiyuu: ['v11\tc1\t2\tPS2 version'],
      staff: ['s1\tja\t1\tp1'],
      staff_alias: ['s1\t1\tWriter\t\\N', 's1\t2\tVoice alias\t\\N'],
      producers: ['p1\tja\tDeveloper', 'p2\tja\tParent', 'p3\tja\tUnrelated parent'],
      producers_relations: ['p1\tp2\tpar', 'p2\tp3\tpar'],
      tags: ['g1\tHoly Grail War', 'g2\tBattle', 'g3\tTheme', 'g99\tUnrelated'],
      tags_parents: ['g1\tg2\tt', 'g2\tg3\tt'],
      tags_vn: ['g1\tv11\tu1\t3\t2\tf', 'g1\tv11\tu2\t-1\t0\tt', 'g99\tv3\tu3\t3\t0\tf'],
      vn_anime: ['v11\t1'],
      anime: ['1\tFate anime'],
      engines: ['1\tKiriKiri'],
      drm: ['1\tSerial key'],
      vn_extlinks: ['v11\t1'],
      extlinks: ['1\twikidata\t42'],
      wikidata: ['42\tFate/stay night'],
      vn_screenshots: ['v11\tsf1\tr1'],
      images: ['cv1\t600\t800', 'cv2\t640\t480', 'ch1\t200\t300', 'sf1\t640\t480'],
      image_votes: ['cv1\tu1\t0', 'ch1\tu2\t1'],
      quotes: ['q1\tv11\tc1\tQuoted\\tline'],
      entry_meta: ['v11\t23'],
    }),
  );
  expect(source.roots).toEqual(['vndb:vn:v11']);
  expect(source.scope.family).toEqual(['v11', 'v2']);
  expect(source.records.find((record) => record.key === 'vndb:vn:v11')?.semanticTypes).toEqual([
    'https://schema.org/VideoGame',
  ]);
  const byKey = new Map(source.records.map((record) => [record.key, record]));
  expect(byKey.has('vndb:vn:v4')).toBe(true);
  expect(byKey.has('vndb:release:r3')).toBe(true);
  expect(byKey.has('vndb:character:c2')).toBe(true);
  expect(byKey.has('vndb:producer:p2')).toBe(true);
  expect(byKey.has('vndb:producer:p3')).toBe(false);
  expect(byKey.has('vndb:tag:g99')).toBe(false);
  expect(byKey.get('vndb:vn:v11')?.data).toMatchObject({
    description: 'A\nB',
    tables: {
      tags_vn: [
        { vote: '3', spoiler: '2', ignore: 'f' },
        { vote: '-1', spoiler: '0', ignore: 't' },
      ],
      entry_meta: [{ revision: '23' }],
    },
  });
  expect(byKey.get('vndb:release:r1')?.data).toMatchObject({
    tables: {
      releases_platforms: [{ platform: 'win' }, { platform: 'lin' }],
      releases_vn: [
        { vid: 'v11', rtype: 'complete' },
        { vid: 'v3', rtype: 'trial' },
      ],
    },
  });
  expect(byKey.get('vndb:character:c1')?.title).toBe('セイバー');
  expect(byKey.get('vndb:image:ch1')?.sourceUrl).toBe('https://t.vndb.org/ch/01/1.jpg');
  expect(byKey.get('vndb:image:cv1')?.sourceUrl).toBe('https://t.vndb.org/cv/01/1.jpg');
  expect(source.images).toContainEqual({
    record: 'vndb:release:r1',
    role: 'cover:release:pkgfront',
    url: 'https://t.vndb.org/cv/02/2.jpg',
  });
  expect(source.edges).toContainEqual({
    from: 'vndb:character:c1',
    to: 'vndb:staff:s1',
    kind: 'voice-actor',
    data: { id: 'v11', cid: 'c1', aid: '2', note: 'PS2 version' },
  });
  for (const edge of source.edges) {
    expect(byKey.has(edge.from)).toBe(true);
    expect(byKey.has(edge.to)).toBe(true);
  }
  expect(source.records.some((record) => record.kind === 'user')).toBe(false);
});
