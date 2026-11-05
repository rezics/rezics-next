import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

// Snapshot from schema_vndbid.sql in https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst
// schema_vndbid.sql SHA-256: d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758
const pinnedTables = {
  anime: ['id', 'ann_id', 'type', 'year', 'title_romaji', 'title_kanji', 'mal_id'],
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
  chars_traits: ['id', 'tid', 'spoil', 'lie'],
  chars_vns: ['id', 'vid', 'rid', 'role', 'spoil'],
  docs: ['id', 'title', 'content'],
  drm: ['id', 'disc', 'cdkey', 'activate', 'alimit', 'account', 'online', 'cloud', 'physical', 'name', 'description'],
  engines: ['id', 'name', 'description'],
  entry_meta: ['id', 'created', 'lastmod', 'revision', 'num_edits', 'num_users'],
  extlinks: ['id', 'site', 'value'],
  image_votes: ['id', 'uid', 'date', 'sexual', 'violence', 'ignore'],
  images: [
    'id',
    'width',
    'height',
    'c_votecount',
    'c_sexual_avg',
    'c_sexual_stddev',
    'c_violence_avg',
    'c_violence_stddev',
    'c_weight',
  ],
  producers: ['id', 'type', 'lang', 'name', 'latin', 'alias', 'description'],
  producers_extlinks: ['id', 'link'],
  producers_relations: ['id', 'pid', 'relation'],
  quotes: ['id', 'vid', 'cid', 'score', 'quote'],
  releases: [
    'id',
    'gtin',
    'olang',
    'released',
    'voiced',
    'reso_x',
    'reso_y',
    'minage',
    'ani_story',
    'ani_ero',
    'ani_story_sp',
    'ani_story_cg',
    'ani_cutscene',
    'ani_ero_sp',
    'ani_ero_cg',
    'ani_bg',
    'ani_face',
    'has_ero',
    'patch',
    'freeware',
    'uncensored',
    'official',
    'catalog',
    'notes',
    'engine',
  ],
  releases_drm: ['id', 'drm', 'notes'],
  releases_extlinks: ['id', 'link'],
  releases_images: ['id', 'img', 'vid', 'itype', 'lang'],
  releases_media: ['id', 'medium', 'qty'],
  releases_platforms: ['id', 'platform'],
  releases_producers: ['id', 'pid', 'developer', 'publisher'],
  releases_supersedes: ['id', 'rid'],
  releases_titles: ['id', 'lang', 'mtl', 'title', 'latin'],
  releases_vn: ['id', 'vid', 'rtype'],
  rlists: ['uid', 'rid', 'added', 'status'],
  staff: ['id', 'gender', 'lang', 'main', 'description', 'prod'],
  staff_alias: ['id', 'aid', 'name', 'latin'],
  staff_extlinks: ['id', 'link'],
  tags: ['id', 'cat', 'defaultspoil', 'searchable', 'applicable', 'name', 'alias', 'description'],
  tags_parents: ['id', 'parent', 'main'],
  tags_vn: ['date', 'tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore', 'lie', 'notes'],
  traits: ['id', 'gid', 'gorder', 'defaultspoil', 'sexual', 'searchable', 'applicable', 'name', 'alias', 'description'],
  traits_parents: ['id', 'parent', 'main'],
  ulist_labels: ['uid', 'id', 'label'],
  ulist_vns: ['uid', 'vid', 'added', 'lastmod', 'vote_date', 'started', 'finished', 'vote', 'notes', 'labels'],
  users: ['id', 'ign_votes', 'perm_imgvote', 'perm_tag', 'perm_lengthvote', 'username'],
  vn: [
    'id',
    'image',
    'c_image',
    'olang',
    'c_votecount',
    'c_rating',
    'c_average',
    'c_length',
    'c_lengthnum',
    'length',
    'devstatus',
    'alias',
    'description',
  ],
  vn_anime: ['id', 'aid'],
  vn_editions: ['id', 'lang', 'eid', 'official', 'name'],
  vn_extlinks: ['id', 'link'],
  vn_image_votes: ['vid', 'uid', 'img'],
  vn_length_votes: ['vid', 'uid', 'date', 'length', 'speed', 'rid', 'notes', 'lang'],
  vn_relations: ['id', 'vid', 'relation', 'official'],
  vn_screenshots: ['id', 'scr', 'rid'],
  vn_seiyuu: ['id', 'cid', 'aid', 'note'],
  vn_staff: ['id', 'aid', 'role', 'eid', 'note'],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  wikidata: [
    'id',
    'enwiki',
    'jawiki',
    'website',
    'vndb',
    'mobygames',
    'mobygames_company',
    'gamefaqs_game',
    'gamefaqs_company',
    'anidb_anime',
    'anidb_person',
    'ann_anime',
    'ann_manga',
    'musicbrainz_artist',
    'twitter',
    'vgmdb_product',
    'vgmdb_artist',
    'discogs_artist',
    'acdb_char',
    'acdb_source',
    'indiedb_game',
    'howlongtobeat',
    'crunchyroll',
    'igdb_game',
    'giantbomb',
    'pcgamingwiki',
    'steam',
    'gog',
    'pixiv_user',
    'doujinshi_author',
    'soundcloud',
    'humblestore',
    'itchio',
    'playstation_jp',
    'playstation_na',
    'playstation_eu',
    'lutris',
    'wine',
    'mobygames_game',
  ],
} as const;

type Column = {
  name: string;
  status: string;
  term?: string;
  inverse?: true;
  on?: string;
  qualifies?: string;
  mapping?: string;
  meaning?: string;
  citations?: string[];
  reason?: string;
  values?: Array<{
    value: string;
    term: string;
    inverse?: true;
    mapping: string;
    meaning?: string;
    citations?: string[];
  }>;
};
type Table = { name: string; type: string; columns: Column[] };
type Inventory = { source: string; snapshot: Record<string, unknown>; tables: Table[] };

function readInventory(): Inventory {
  const source = readFileSync(new URL('../sources/vndb.yaml', import.meta.url), 'utf8');
  return Bun.YAML.parse(source) as Inventory;
}

test('reverse VNDB relations are statements on the related subject', () => {
  const source = Bun.YAML.parse(readFileSync(new URL('../sources/vndb.yaml', import.meta.url), 'utf8')) as {
    enumerations: { vn_relation: NonNullable<Column['values']> };
    table_types: Record<string, { term?: string; inverse?: true; mapping?: string }>;
  };
  for (const [value, term, mapping] of [
    ['preq', 'wdt:P155', 'wdt:P156'],
    ['par', 'wdt:P144', 'wdt:P4969'],
    ['fan', 'rezics:spinOffOf', 'wdt:P2512'],
  ]) {
    expect(source.enumerations.vn_relation.find((entry) => entry.value === value)).toMatchObject({
      term,
      inverse: true,
      mapping,
    });
    expect(source.table_types[mapping!]).toMatchObject({ term, inverse: true, mapping });
    expect(bundledRelease.properties[term!]?.relation?.inverse).toBe(mapping);
  }
});

test('every table and column of the pinned VNDB dump is inventoried exactly once', () => {
  const inventory = readInventory();
  expect(inventory.source).toBe('https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst');
  expect(inventory.snapshot).toMatchObject({
    dump: 'https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst',
    schema: {
      file: 'schema_vndbid.sql',
      sha256: 'd608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758',
    },
  });

  const tableNames = inventory.tables.map(({ name }) => name);
  expect(new Set(tableNames).size).toBe(tableNames.length);
  expect(tableNames.toSorted()).toEqual(Object.keys(pinnedTables).toSorted());
  for (const table of inventory.tables) {
    expect(table.type.length).toBeGreaterThan(0);
    const columnNames = table.columns.map(({ name }) => name);
    expect(new Set(columnNames).size).toBe(columnNames.length);
    expect(columnNames.toSorted()).toEqual([...pinnedTables[table.name as keyof typeof pinnedTables]].toSorted());
  }
});

test('every inventoried term is bundled, proposed by the vocabulary rules, or omitted with a reason', () => {
  const inventory = readInventory();
  const classes = bundledRelease.types;
  const properties = bundledRelease.properties;
  for (const table of inventory.tables) {
    for (const column of table.columns) {
      if (column.status === 'existing') {
        expect(column.term).toBeTruthy();
        expect(column.on).toBeTruthy();
        expect(properties[column.term!]).toBeDefined();
        if (column.inverse !== undefined) {
          expect(column.inverse).toBe(true);
          const property = properties[column.term!];
          expect(property?.datatype).toBe('wikibase-item');
          expect(property?.relation?.inverse).toBeDefined();
          expect(property?.relation?.inverse).not.toBe('none');
          expect(column.qualifies).toBeUndefined();
          const type = classes[column.on!];
          expect([column.on!, ...(type?.bases ?? [])].some((term) => property!.targets!.includes(term))).toBe(true);
        } else if (column.qualifies) {
          expect(classes[column.on!]?.properties).toContain(column.qualifies);
          expect(properties[column.qualifies]?.qualifiers).toContain(column.term);
        } else {
          expect(classes[column.on!]?.properties).toContain(column.term);
        }
      } else if (column.status === 'proposed') {
        expect(column.term).toMatch(/^(schema|wd|wdt|rezics):[A-Za-z0-9_]+$/u);
        expect(column.mapping).toMatch(/^(wd:Q[0-9]+|wdt:P[0-9]+)$/u);
        expect(column.meaning).toBeTruthy();
        expect(column.meaning).not.toMatch(/[\r\n]/u);
        const citations = column.citations ?? [];
        if (column.term!.startsWith('schema:'))
          expect(citations).toContain(`https://schema.org/${column.term!.slice('schema:'.length)}`);
        if (column.mapping!.startsWith('wd:Q'))
          expect(citations).toContain(`https://www.wikidata.org/wiki/${column.mapping!.slice('wd:'.length)}`);
        if (column.mapping!.startsWith('wdt:P'))
          expect(citations).toContain(
            `https://www.wikidata.org/wiki/Property:${column.mapping!.slice('wdt:P'.length)}`,
          );
        if (column.term!.startsWith('rezics:')) expect(column.meaning).toMatch(/platform mechanism/iu);
      } else {
        expect(column.status).toBe('omitted');
        expect(column.reason).toBeTruthy();
      }
      for (const value of column.values ?? []) {
        expect(value.term).toMatch(/^(schema|wd|wdt|rezics):[A-Za-z0-9_]+$/u);
        expect(value.mapping).toMatch(/^(wd:Q[0-9]+|wdt:P[0-9]+)$/u);
        expect(value.meaning).toBeTruthy();
        expect(value.citations?.length).toBeGreaterThan(0);
        if (value.inverse !== undefined) {
          expect(value.inverse).toBe(true);
          const property = properties[value.term];
          expect(property?.datatype).toBe('wikibase-item');
          expect(property?.relation?.inverse).toBe(value.mapping);
        }
      }
    }
  }
});
