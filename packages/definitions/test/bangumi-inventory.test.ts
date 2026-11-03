import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '../src/bundled.ts';

// Full field union (including nested statistics) from all rows of the eight named files in
// https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-20.210332Z.zip
// Release tag: archive; SHA-256 independently checked against GitHub's asset digest.
const snapshot = {
  tag: 'archive',
  asset: 'dump-2026-10-20.210332Z.zip',
  sha256: '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93',
  archiveCommit: '959474a4fcb833f6dabe8dd2f4fe192f82a71140',
  commonCommit: '2ee87b9995353f77cf02e390e8635bf97dbc1fa2',
  apiCommit: '65d29cff2331e08c0110d30d515f7f1b6488f845',
};

const fields: Record<string, string[]> = {
  subject: [
    'date',
    'favorite',
    'favorite.doing',
    'favorite.done',
    'favorite.dropped',
    'favorite.on_hold',
    'favorite.wish',
    'id',
    'infobox',
    'meta_tags',
    'name',
    'name_cn',
    'nsfw',
    'platform',
    'rank',
    'score',
    'score_details',
    'score_details.1',
    'score_details.10',
    'score_details.2',
    'score_details.3',
    'score_details.4',
    'score_details.5',
    'score_details.6',
    'score_details.7',
    'score_details.8',
    'score_details.9',
    'series',
    'summary',
    'tags',
    'tags.[].count',
    'tags.[].name',
    'type',
  ],
  person: ['career', 'collects', 'comments', 'id', 'infobox', 'name', 'summary', 'type'],
  character: ['collects', 'comments', 'id', 'infobox', 'name', 'role', 'summary'],
  episode: ['airdate', 'description', 'disc', 'duration', 'id', 'name', 'name_cn', 'sort', 'subject_id', 'type'],
  'subject-relations': ['order', 'related_subject_id', 'relation_type', 'subject_id'],
  'subject-persons': ['appear_eps', 'person_id', 'position', 'subject_id'],
  'subject-characters': ['character_id', 'order', 'subject_id', 'type'],
  'person-characters': ['character_id', 'person_id', 'subject_id', 'summary', 'type'],
};

// Primary wiki templates, including each anime/book platform's template and manga:
// https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/wiki_template.yml
// Crt is shared by character/person infoboxes; alias tuple keys are listed separately.
const infobox: Record<string, string[]> = {
  TVAnime: [
    '中文名',
    '别名',
    '话数',
    '放送开始',
    '放送星期',
    '官方网站',
    '在线播放平台',
    '播放电视台',
    '其他电视台',
    '播放结束',
    '导演',
    '音乐',
    '链接',
    '其他',
    'Copyright',
  ],
  OVA: ['中文名', '别名', '话数', '发售日', '官方网站', '开始', '结束', '链接', '其他'],
  Movie: ['中文名', '别名', '上映年度', '片长', '官方网站', '链接', '其他', 'Copyright'],
  Anime: ['中文名', '别名', '上映年度', '片长', '官方网站', '链接', '其他', 'Copyright'],
  Book: [
    '中文名',
    '别名',
    '作者',
    '插图',
    '出版社',
    '价格',
    '其他出版社',
    '连载杂志',
    '发售日',
    '页数',
    'ISBN',
    '链接',
    '其他',
  ],
  PhotoBook: [
    '中文名',
    '别名',
    '作者',
    '摄影',
    '出版社',
    '价格',
    '其他出版社',
    '连载杂志',
    '发售日',
    '页数',
    'ISBN',
    '链接',
    '其他',
  ],
  Manga: [
    '中文名',
    '别名',
    '作者',
    '作画',
    '脚本',
    '原作',
    '出版社',
    '价格',
    '其他出版社',
    '连载杂志',
    '发售日',
    '册数',
    '页数',
    '话数',
    'ISBN',
    '链接',
    '其他',
  ],
  Novel: [
    '中文名',
    '别名',
    '作者',
    '插图',
    '出版社',
    '价格',
    '连载杂志',
    '发售日',
    '册数',
    '页数',
    '话数',
    'ISBN',
    '链接',
    '其他',
  ],
  BookSeries: ['中文名', '别名', '出版社', '连载杂志', '开始', '结束', '册数', '话数', '原作', '链接', '其他'],
  Game: [
    '中文名',
    '别名',
    '平台',
    '游戏类型',
    '游戏引擎',
    '游玩人数',
    '发行日期',
    '售价',
    '开发',
    '发行',
    '剧本',
    '程序',
    'website',
    '链接',
  ],
  Crt: ['简体中文名', '别名', '性别', '生日', '血型', '身高', '体重', 'BWH', '引用来源'],
  doujinBook: ['作者', '原作', 'CP', '语言', '页数', '尺寸', '价格', '发售日'],
  doujinGame: ['别名', '开发者', '原作', '平台', '游戏类型', '游戏引擎', '游玩人数', '语言', '价格', '发售日'],
  'Crt.aliases': ['第二中文名', '英文名', '日文名', '纯假名', '罗马字', '昵称'],
};

// Numeric subject/platform/staff/relation definitions:
// https://github.com/bangumi/common/tree/2ee87b9995353f77cf02e390e8635bf97dbc1fa2
// subject_platforms.yml, subject_staffs.yml and subject_relations.yml.
// Episode, person and character kinds:
// https://github.com/bangumi/api/blob/65d29cff2331e08c0110d30d515f7f1b6488f845/open-api/v0.yaml
// EpType, PersonType, CharacterType. Appearance roles 1..3:
// https://github.com/bangumi/Archive/blob/959474a4fcb833f6dabe8dd2f4fe192f82a71140/README.md
// Also retain observed undocumented codes: person.type=0, appearance.type=4..6,
// person-characters.type=0..6, platform.anime/music=0, and retired game relation=4013.
// PersonCareer is the string enumeration in the same pinned API document. Never infer undocumented meanings.
const enumerations: Record<string, (string | number)[]> = {
  'subject.type': [1, 2, 3, 4, 6],
  'subject.series': ['false', 'true'],
  'episode.type': [0, 1, 2, 3, 4, 5, 6],
  'person.type': [0, 1, 2, 3],
  'person.career': ['producer', 'mangaka', 'artist', 'seiyu', 'writer', 'illustrator', 'actor'],
  'character.role': [1, 2, 3, 4],
  'subject-characters.type': [1, 2, 3, 4, 5, 6],
  'person-characters.type': [0, 1, 2, 3, 4, 5, 6],
  'platform.book': [0, 1001, 1002, 1003, 1004, 1005, 1006],
  'platform.anime': [0, 1, 2, 3, 4, 5, 2006],
  'platform.real': [0, 1, 2, 3, 6001, 6002, 6003, 6004],
  'platform.music': [0, 3001, 3002, 3003, 3004],
  'platform.game': [0, 4001, 4002, 4003, 4004, 4005],
  'staff.2': [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
    62, 63, 64, 65, 66, 67, 69, 70, 71, 72, 73, 74, 75, 76, 77, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93,
    94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
    118, 119, 120, 121, 122, 123, 124, 125, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141,
    142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164,
    165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182,
  ],
  'staff.4': [
    1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019,
    1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034, 1035,
  ],
  'staff.1': [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017],
  'staff.3': [
    3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019,
    3020, 3021, 3022, 3023,
  ],
  'staff.6': [
    4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010, 4011, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019,
    4020, 4021, 4022, 4023, 4024, 4025, 4026, 4027, 4028, 4029, 4030, 4031, 4032, 4033, 4034, 4035, 4036, 4037, 4038,
    4039, 4040, 4041, 4042, 4043, 4044,
  ],
  'relation.2': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 99],
  'relation.1': [1, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1010, 1011, 1012, 1013, 1014, 1015, 1099],
  'relation.3': [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3099],
  'relation.4': [1, 4002, 4003, 4006, 4007, 4008, 4009, 4010, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019, 4099],
  'relation.6': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 99],
};

type Decision = {
  status: 'existing' | 'proposed' | 'omitted';
  term?: string;
  inverse?: true;
  canonicalByReverse?: Record<string, { term: string }>;
  on?: string;
  qualifies?: string;
  wikidata?: string;
  meaning?: string;
  reason?: string;
  sources?: string[];
  recordCheck?: {
    subject: number;
    related: number;
    forward: number;
    reverse: number | null;
    observation: string;
  };
  licence?: { id: string; url: string };
  qualifiers?: Record<string, Decision>;
  value?: Decision;
  profile?: Decision;
  concept?: { id: string; scheme: string; label: string };
};
type Entry = { id: string | number; mapping: Decision };
type Inventory = {
  source: string;
  snapshot: typeof snapshot & { url: string; licence: { id: string; url: string; source: string } };
  files: { id: string; type: Decision; fields: Entry[] }[];
  infobox: { id: string; fields: Entry[] }[];
  enumerations: { id: string; values: Entry[] }[];
  vocabulary: Decision[];
};

const inventory = () =>
  Bun.YAML.parse(readFileSync(new URL('../sources/bangumi.yaml', import.meta.url), 'utf8')) as Inventory;

const subjectRelations = () =>
  inventory().enumerations.filter(({ id }) => ['relation.1', 'relation.2', 'relation.4'].includes(id));
const relationsDocument = `https://github.com/bangumi/common/blob/${snapshot.commonCommit}/subject_relations.yml`;
const archiveAsset = `https://github.com/bangumi/Archive/releases/download/archive/${snapshot.asset}`;

// Independently checked subject-relations.jsonlines rows in the SHA-256-pinned asset.
// Code, subject_id, related_subject_id, reciprocal code, canonical property, related holder.
// Parent Story uses the reciprocal's more specific property so that both rows store one fact.
const checkedRelations: Record<string, [number, number, number, number | null, string, boolean?][]> = {
  'relation.1': [
    [1, 1, 296317, 1, 'rezics:crossMediaCounterpart'],
    [1002, 26, 499, 1003, 'wdt:P179'],
    [1003, 495, 90, 1002, 'wdt:P179', true],
    [1004, 10, 497, 1004, 'rezics:artbookCounterpart'],
    [1005, 31, 30, 1006, 'wdt:P155'],
    [1006, 30, 31, 1005, 'wdt:P155', true],
    [1007, 49, 51234, 1008, 'rezics:sideStoryOf', true],
    [1008, 1236, 7791, 1007, 'rezics:sideStoryOf'],
    [1010, 29, 326025, 1010, 'rezics:editionCounterpart'],
    [1011, 335, 41336, 1011, 'rezics:sameCharacters'],
    [1012, 76, 77, 1012, 'rezics:sameSetting'],
    [1013, 505, 17326, 1013, 'rezics:alternativeSetting'],
    [1014, 1674, 147362, 1014, 'rezics:collaborationWith'],
    [1015, 5110, 132876, 1015, 'rezics:alternativeVersion'],
    [1099, 11, 497, 1099, 'rezics:bangumiRelatedTo'],
  ],
  'relation.2': [
    [1, 12, 497, 1, 'rezics:crossMediaCounterpart'],
    [2, 8, 793, 3, 'wdt:P155'],
    [3, 51, 876, 2, 'wdt:P155', true],
    [4, 8, 99952, 5, 'rezics:summaryOf', true],
    [5, 1999, 975, 4, 'rezics:summaryOf'],
    [6, 8, 35866, 12, 'rezics:sideStoryOf', true],
    [7, 12, 2478, 7, 'rezics:sameCharacters'],
    [8, 50, 985, 8, 'rezics:sameSetting'],
    [9, 8, 199228, 9, 'rezics:alternativeSetting'],
    [10, 8, 199229, 10, 'rezics:alternativeVersion'],
    [11, 50, 106834, 12, 'rezics:spinOffOf', true],
    [12, 314, 24274, 6, 'rezics:sideStoryOf'],
    [14, 47, 515, 7, 'rezics:collaborationWith'],
    [99, 150, 458009, 99, 'rezics:bangumiRelatedTo'],
  ],
  'relation.4': [
    [1, 13, 51, 1, 'rezics:crossMediaCounterpart'],
    [4002, 4, 9944, 4003, 'wdt:P155'],
    [4003, 9, 20482, 4002, 'wdt:P155', true],
    [4006, 13, 3660, 4012, 'rezics:sideStoryOf', true],
    [4007, 13, 1172, 4007, 'rezics:sameCharacters'],
    [4008, 40, 43, 4008, 'rezics:sameSetting'],
    [4009, 143, 329302, 4009, 'rezics:alternativeSetting'],
    [4010, 40, 41, 4010, 'rezics:alternativeVersion'],
    [4012, 123, 300296, 4006, 'rezics:sideStoryOf'],
    [4013, 122686, 563561, 4013, 'rezics:bangumiLegacyVersion'],
    [4014, 6, 20810, 4014, 'rezics:collaborationWith'],
    [4015, 171, 30448, 4015, 'rezics:expansionCounterpart'],
    [4016, 40, 492287, 4017, 'schema:exampleOfWork', true],
    [4017, 124, 84156, 4016, 'schema:exampleOfWork'],
    [4018, 6, 108488, 4019, 'wdt:P361'],
    [4019, 3681, 608727, 4018, 'wdt:P361', true],
    [4099, 52, 472985, 4099, 'rezics:bangumiRelatedTo'],
  ],
};

test('every Bangumi subject relation type maps to a directed or symmetric release property', () => {
  for (const group of subjectRelations()) {
    for (const entry of group.values) {
      const mapping = entry.mapping;
      if (group.id === 'relation.1' && entry.id === 1003) {
        expect(mapping.status).toBe('omitted');
        expect(mapping.reason).toContain("member's part-of-the-series statement");
        continue;
      }
      expect(mapping.status).not.toBe('omitted');
      const property = bundledRelease.properties[mapping.term ?? ''];
      expect(property?.datatype).toBe('wikibase-item');
      expect(property?.relation).toBeDefined();
      expect(property!.relation!.inverse).not.toBe('none');
      expect(property!.relation!.symmetric || property!.relation!.inverse).toBeTruthy();
      if (mapping.inverse) expect(property!.relation!.symmetric).not.toBe(true);
    }
  }
});

test('each mapped Bangumi relation direction is checked against a cited record', () => {
  for (const group of subjectRelations()) {
    exactIds(
      group.values,
      checkedRelations[group.id]!.map(([code]) => code),
    );
    for (const entry of group.values) {
      const mapping = entry.mapping;
      expect(mapping.sources).toContain(relationsDocument);
      const check = mapping.recordCheck;
      expect(check).toBeDefined();
      expect(check!.subject).toBeGreaterThan(0);
      expect(check!.related).toBeGreaterThan(0);
      expect(check!.subject).not.toBe(check!.related);
      expect(check!.forward).toBe(Number(entry.id));
      expect(check!.reverse === null || Number.isInteger(check!.reverse)).toBe(true);
      expect(check!.observation.trim().length).toBeGreaterThan(40);
      const [code, subject, related, reverse, term, inverse = false] = checkedRelations[group.id]!.find(
        ([code]) => code === entry.id,
      )!;
      expect(check).toMatchObject({ subject, related, forward: code, reverse });
      expect(mapping.sources).toContain(
        `${archiveAsset}#subject-relations.jsonlines/${check!.subject}/${check!.related}`,
      );
      if (mapping.status === 'omitted') continue;
      const canonical = mapping.canonicalByReverse?.[String(reverse)] ?? mapping;
      expect(canonical.term).toBe(term);
      expect(mapping.inverse ?? false).toBe(inverse);
    }
  }
});

test('reciprocal parent-story codes resolve to one specific canonical statement', () => {
  const mappings = subjectRelations().flatMap(({ values }) => values);
  for (const code of [12, 1008, 4012]) {
    const mapping = mappings.find(({ id }) => id === code)!.mapping;
    expect(mapping.term).toBe('wdt:P361');
    expect(mapping.inverse).toBeUndefined();
    expect(mapping.canonicalByReverse).toEqual({
      6: { term: 'rezics:sideStoryOf' },
      1007: { term: 'rezics:sideStoryOf' },
      4006: { term: 'rezics:sideStoryOf' },
      11: { term: 'rezics:spinOffOf' },
    });
    for (const [reverse, canonical] of Object.entries(mapping.canonicalByReverse!)) {
      const reciprocal = mappings.find(({ id }) => id === Number(reverse))!.mapping;
      expect(reciprocal).toMatchObject({ term: canonical.term, inverse: true });
    }
  }
});

test('source distinctions remain readable on all work profiles in every locale', () => {
  const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
  for (const group of subjectRelations()) {
    for (const { mapping } of group.values) {
      if (mapping.status === 'omitted') continue;
      const property = bundledRelease.properties[mapping.term!]!;
      expect(Object.keys(property.labels).sort()).toEqual(locales);
      if (mapping.term!.startsWith('rezics:')) {
        expect(property.targets).toContain('schema:CreativeWork');
        for (const type of Object.values(bundledRelease.types)) {
          if (type.bases.includes('schema:CreativeWork')) expect(type.properties).toContain(mapping.term!);
        }
      }
    }
  }
  for (const term of ['rezics:sameSetting', 'rezics:alternativeVersion', 'rezics:sameCharacters'])
    expect(bundledRelease.properties[term]?.relation).toMatchObject({ symmetric: true, group: 'world' });
  for (const term of ['rezics:summaryOf', 'rezics:sideStoryOf'])
    expect(bundledRelease.properties[term]?.relation?.acyclic).toBe(true);
  expect(bundledRelease.properties['rezics:bangumiRelatedTo']?.labels.en).toBe('Related (Bangumi)');
});

function exactIds(entries: { id: string | number }[], expected: (string | number)[]) {
  const ids = entries.map(({ id }) => String(id));
  expect(ids.length).toBe(new Set(ids).size);
  expect(ids.toSorted()).toEqual(expected.map(String).toSorted());
}

test('every field, infobox key and enumeration of the pinned Bangumi archive is inventoried exactly once', () => {
  const data = inventory();
  expect(data.source).toBe('Bangumi Archive');
  expect(data.snapshot).toMatchObject(snapshot);
  expect(data.snapshot.url).toBe(`https://github.com/bangumi/Archive/releases/download/archive/${snapshot.asset}`);
  expect(data.snapshot.licence).toEqual({
    id: 'CC-BY-SA-3.0',
    url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    source: 'https://bgm.tv/about/copyright',
  });
  exactIds(data.files, Object.keys(fields));
  for (const file of data.files) exactIds(file.fields, fields[file.id]!);
  exactIds(data.infobox, Object.keys(infobox));
  for (const template of data.infobox) exactIds(template.fields, infobox[template.id]!);
  exactIds(data.enumerations, Object.keys(enumerations));
  for (const group of data.enumerations) exactIds(group.values, enumerations[group.id]!);
});

// Closed list checked against the primary vocabulary definitions, not against the inventory at test time:
// https://schema.org/version/latest/schemaorg-current-https.jsonld and the Wikidata entity/property
// pages cited by each mapping. This rejects invented schema.org terms and unrelated property IDs.
const primaryTerms: Record<string, string[]> = {
  'schema:Book': ['wd:Q47461344'],
  'schema:BookSeries': ['wd:Q277759'],
  'schema:ComicSeries': ['wd:Q21198342'],
  'schema:CreativeWork': ['wd:Q17537576'],
  'schema:CreativeWorkSeries': ['wd:Q7725310'],
  'schema:Episode': ['wd:Q1983062'],
  'schema:Game': ['wd:Q11410'],
  'schema:Movie': ['wd:Q11424'],
  'schema:MusicAlbum': ['wd:Q482994'],
  'schema:Organization': ['wd:Q43229'],
  'schema:Person': ['wd:Q5'],
  'schema:TVSeries': ['wd:Q5398426'],
  'schema:VideoGame': ['wd:Q7889'],
  'schema:abstract': ['wd:Q333291'],
  'schema:alternateName': ['wd:P2561'],
  'schema:author': ['wd:P50'],
  'schema:birthDate': ['wd:P569'],
  'schema:character': ['wd:P674'],
  'schema:citation': ['wd:P248'],
  'schema:contributor': ['wd:P767'],
  'schema:copyrightNotice': ['wd:P6216'],
  'schema:datePublished': ['wd:P577'],
  'schema:director': ['wd:P57'],
  'schema:duration': ['wd:P2047'],
  'schema:editor': ['wd:P98'],
  'schema:endDate': ['wd:P582'],
  'schema:episodeNumber': ['wd:P1545'],
  'schema:exampleOfWork': ['wd:P629'],
  'schema:gamePlatform': ['wd:P400'],
  'schema:gender': ['wd:P21'],
  'schema:genre': ['wd:P136'],
  'schema:hasOccupation': ['wd:P106'],
  'schema:hasPart': ['wd:P527'],
  'schema:height': ['wd:P2048'],
  'schema:illustrator': ['wd:P110'],
  'schema:image': ['wd:P18'],
  'schema:inLanguage': ['wd:P407'],
  'schema:isPartOf': ['wd:P361'],
  'schema:isbn': ['wd:P212'],
  'schema:keywords': ['wd:P921'],
  'schema:lyricist': ['wd:P676'],
  'schema:musicBy': ['wd:P86'],
  'schema:name': ['wd:P2561'],
  'schema:numberOfEpisodes': ['wd:P1113'],
  'schema:numberOfPages': ['wd:P1104'],
  'schema:numberOfPlayers': ['wd:P1873'],
  'schema:position': ['wd:P1545'],
  'schema:producer': ['wd:P162'],
  'schema:productionCompany': ['wd:P272'],
  'schema:publisher': ['wd:P123'],
  'schema:startDate': ['wd:P580'],
  'schema:translator': ['wd:P655'],
  'schema:url': ['wd:P2888', 'wd:P856'],
  'schema:weight': ['wd:P2067'],
  'schema:workExample': ['wd:P747'],
  'skos:Concept': ['wd:Q151885'],
  'skos:ConceptScheme': ['wd:Q5962346'],
  'skos:inScheme': ['wd:P361'],
  'wd:Q7397': ['wd:Q7397'],
  'wd:Q209163': ['wd:Q209163'],
  'wd:Q95074': ['wd:Q95074'],
  'wdt:P1433': ['wd:P1433'],
  'wdt:P155': ['wd:P155'],
  'wdt:P1552': ['wd:P1552'],
  'wdt:P156': ['wd:P156'],
  'wdt:P178': ['wd:P178'],
  'wdt:P179': ['wd:P179'],
  'wdt:P1853': ['wd:P1853'],
  'wdt:P1932': ['wd:P1932'],
  'wdt:P2512': ['wd:P2512'],
  'wdt:P2635': ['wd:P2635'],
  'wdt:P287': ['wd:P287'],
  'wdt:P361': ['wd:P361'],
  'wdt:P527': ['wd:P527'],
  'wdt:P31': ['wd:P31'],
  'wdt:P3831': ['wd:P3831'],
  'wdt:P408': ['wd:P408'],
  'wdt:P449': ['wd:P449'],
  'wdt:P453': ['wd:P453'],
  'wdt:P518': ['wd:P518'],
  'wdt:P5732': ['wd:P5732'],
  'wdt:P6296': ['wd:P6296'],
  'wdt:P6298': ['wd:P6298'],
  'wdt:P6942': ['wd:P6942'],
  'wdt:P725': ['wd:P725'],
  'wdt:P7937': ['wd:P7937'],
  'wdt:P973': ['wd:P973'],
};

const conceptIds = new Set<string>();
function validate(mapping: Decision) {
  expect(['existing', 'proposed', 'omitted']).toContain(mapping.status);
  if (mapping.status === 'omitted') {
    expect(mapping.reason?.trim().length).toBeGreaterThan(15);
    expect(mapping.term).toBeUndefined();
    return;
  }
  expect(mapping.meaning?.trim().length).toBeGreaterThan(10);
  let sourceTerm = mapping.term ?? '';
  if (mapping.inverse !== undefined) {
    expect(mapping.inverse).toBe(true);
    const property = bundledRelease.properties[sourceTerm];
    expect(property?.datatype).toBe('wikibase-item');
    expect(property?.relation?.inverse).toBeDefined();
    expect(property?.relation?.inverse).not.toBe('none');
    expect(mapping.qualifies).toBeUndefined();
    sourceTerm = property!.relation!.inverse!;
  }
  if (mapping.term?.startsWith('rezics:') && mapping.wikidata === undefined) {
    expect(mapping.status).toBe('existing');
    const property = bundledRelease.properties[mapping.term];
    expect(property?.datatype).toBe('wikibase-item');
    expect(property?.relation).toBeDefined();
    expect(property?.relation?.inverse).not.toBe('none');
    expect(bundledRelease.types[mapping.on ?? '']?.properties).toContain(mapping.term);
    expect(Object.keys(property!.labels).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
    expect(mapping.sources).toContain(relationsDocument);
    return;
  }
  expect(mapping.wikidata).toMatch(/^wd:[PQ][1-9][0-9]*$/);
  expect(primaryTerms[sourceTerm]).toContain(mapping.wikidata);
  if (mapping.status === 'existing') {
    const type = bundledRelease.types[mapping.on ?? ''];
    expect(type).toBeDefined();
    if (mapping.inverse) {
      const targets = bundledRelease.properties[mapping.term!]!.targets!;
      expect([mapping.on!, ...type!.bases].some((term) => targets.includes(term))).toBe(true);
    } else if (mapping.qualifies) {
      expect(type!.properties).toContain(mapping.qualifies);
      expect(bundledRelease.properties[mapping.qualifies]?.qualifiers).toContain(mapping.term);
    } else {
      expect(mapping.term === mapping.on || type!.properties.includes(mapping.term!)).toBe(true);
    }
    expect(bundledRelease.types[mapping.term!] ?? bundledRelease.properties[mapping.term!]).toBeDefined();
  } else {
    expect(mapping.term).toMatch(
      /^(?:schema:[A-Za-z]+|wd:Q[1-9][0-9]*|wdt:P[1-9][0-9]*|skos:(?:Concept|ConceptScheme|inScheme))$/,
    );
    const wikidataPage = `https://www.wikidata.org/wiki/${mapping.wikidata!.replace('wd:P', 'Property:P').replace('wd:Q', 'Q')}`;
    expect(mapping.sources).toContain(wikidataPage);
    if (sourceTerm.startsWith('schema:'))
      expect(mapping.sources).toContain(`https://schema.org/${sourceTerm.slice(7)}`);
    if (sourceTerm.startsWith('wdt:')) expect(mapping.wikidata).toBe(sourceTerm.replace('wdt:', 'wd:'));
    if (mapping.term!.startsWith('wd:')) expect(mapping.wikidata).toBe(mapping.term);
    if (mapping.term!.startsWith('skos:'))
      expect(mapping.sources).toContain(`https://www.w3.org/2004/02/skos/core#${mapping.term!.slice(5)}`);
  }
  if (mapping.concept) {
    expect(mapping.term).toBe('skos:Concept');
    expect(mapping.concept.id.startsWith(`${mapping.concept.scheme}/`)).toBe(true);
    expect(mapping.concept.label.length).toBeGreaterThan(0);
    expect(conceptIds.has(mapping.concept.id)).toBe(false);
    conceptIds.add(mapping.concept.id);
  }
  if (mapping.profile) validate(mapping.profile);
  if (mapping.value) validate(mapping.value);
  for (const qualifier of Object.values(mapping.qualifiers ?? {})) validate(qualifier);
}

test('reverse Bangumi relations retain their source meaning through canonical mappings', () => {
  const data = inventory();
  for (const [group, id, term, wikidata] of [
    ['relation.2', 3, 'wdt:P155', 'wd:P156'],
    ['relation.1', 1006, 'wdt:P155', 'wd:P156'],
    ['relation.4', 4003, 'wdt:P155', 'wd:P156'],
    ['relation.4', 4016, 'schema:exampleOfWork', 'wd:P747'],
  ] as const) {
    const mapping = data.enumerations
      .find((entry) => entry.id === group)!
      .values.find((entry) => entry.id === id)!.mapping;
    expect(mapping).toMatchObject({ term, inverse: true, wikidata });
    expect(mapping.meaning).toBeTruthy();
  }
});

test('every inventoried Bangumi term is bundled, proposed by the vocabulary rules, or omitted with a reason', () => {
  const data = inventory();
  conceptIds.clear();
  for (const file of data.files) {
    validate(file.type);
    for (const field of file.fields) validate(field.mapping);
    const summary = file.fields.find(({ id }) => id === 'summary' || id === 'description');
    if (summary) expect(summary.mapping.licence).toEqual({ id: 'CC-BY-SA-3.0', url: data.snapshot.licence.url });
  }
  for (const template of data.infobox) for (const field of template.fields) validate(field.mapping);
  for (const group of data.enumerations) for (const entry of group.values) validate(entry.mapping);
  for (const mapping of data.vocabulary) validate(mapping);
  const group = (id: string) => data.enumerations.find((entry) => entry.id === id)!.values;
  for (const id of ['staff.3', 'staff.6', 'relation.3', 'relation.6'])
    for (const entry of group(id)) expect(entry.mapping.status).toBe('omitted');
  expect(group('subject.type').find((entry) => entry.id === 3)!.mapping).toMatchObject({
    status: 'existing',
    term: 'schema:MusicAlbum',
    on: 'schema:MusicAlbum',
  });
  expect(group('subject.type').find((entry) => entry.id === 6)!.mapping.status).toBe('omitted');
  expect(group('platform.real').find((entry) => entry.id === 6002)!.mapping.profile?.term).toBe('schema:Movie');
  for (const id of [0, 1, 2, 3, 6001, 6003, 6004])
    expect(group('platform.real').find((entry) => entry.id === id)!.mapping.profile?.term).toBe('schema:TVSeries');
  expect(group('platform.music').find((entry) => entry.id === 0)!.mapping.profile?.term).toBe('schema:MusicAlbum');
  for (const id of [3001, 3002, 3003, 3004])
    expect(group('platform.music').find((entry) => entry.id === id)!.mapping.status).toBe('omitted');
  for (const file of data.files)
    for (const field of file.fields)
      if (/^(tags|favorite|score|score_details|rank|comments|collects)(\.|$)/.test(String(field.id)))
        expect(field.mapping.status).toBe('omitted');
  for (const id of ['staff.1', 'staff.2', 'staff.4'])
    for (const entry of group(id)) {
      const credit = entry.mapping;
      expect(credit.qualifiers?.role?.term).toBe('wdt:P3831');
      expect(credit.qualifiers?.creditedAs?.term).toBe('wdt:P1932');
      expect(credit.qualifiers?.order?.term).toBe('schema:position');
      expect(credit.qualifiers?.role?.concept).toBeUndefined();
      expect(credit.qualifiers?.role?.value?.concept?.scheme).toBe('https://rezics.com/schemes/bangumi/staff');
    }
  const staffTerm = (scheme: string, id: number) => group(scheme).find((entry) => entry.id === id)!.mapping.term;
  for (const [scheme, id, term] of [
    ['staff.1', 2001, 'schema:author'],
    ['staff.1', 2002, 'schema:illustrator'],
    ['staff.1', 2004, 'schema:publisher'],
    ['staff.1', 2006, 'schema:translator'],
    ['staff.2', 2, 'schema:director'],
    ['staff.2', 6, 'schema:musicBy'],
    ['staff.2', 67, 'schema:productionCompany'],
    ['staff.2', 66, 'schema:contributor'],
    ['staff.4', 1001, 'wdt:P178'],
  ] as const)
    expect(staffTerm(scheme, id)).toBe(term);
  for (const file of ['character', 'subject-characters'])
    expect(
      data.files
        .find(({ id }) => id === file)!
        .fields.find(({ id }) => id === (file === 'character' ? 'id' : 'character_id'))!.mapping.term,
    ).toBe('wdt:P6296');
  const game = data.infobox.find(({ id }) => id === 'Game')!;
  expect(game.fields.find(({ id }) => id === '游戏引擎')!.mapping.term).toBe('wdt:P408');
  expect(game.fields.find(({ id }) => id === '平台')!.mapping.term).toBe('schema:gamePlatform');
  expect(group('platform.game').find((entry) => entry.id === 4001)!.mapping.profile?.term).toBe('schema:VideoGame');
  for (const id of [4002, 4005]) {
    const profile = group('platform.game').find((entry) => entry.id === id)!.mapping.profile;
    expect(profile?.status).toBe('omitted');
    expect(profile?.reason?.trim().length).toBeGreaterThan(15);
    expect(profile?.term).toBeUndefined();
  }
  expect(data.files.find(({ id }) => id === 'person-characters')!.type).toMatchObject({
    term: 'wdt:P725',
    qualifiers: { character: { term: 'wdt:P453' } },
  });
  const appearance = data.files.find(({ id }) => id === 'subject-characters')!.type;
  expect(appearance.term).toBe('schema:character');
  expect(appearance.wikidata).toBe('wd:P674');
  expect(appearance.qualifiers?.role?.term).toBe('wdt:P3831');
  for (const term of ['skos:Concept', 'skos:ConceptScheme'])
    expect(data.vocabulary.some((entry) => entry.term === term)).toBe(true);
});
