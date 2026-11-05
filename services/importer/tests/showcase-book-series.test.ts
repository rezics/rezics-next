import { expect, test } from 'bun:test';
import { convertBangumi } from '@rezics/conversion/bangumi';
import type { CrossMediaTables } from '../src/cross-media-seed.ts';
import { planShowcaseBooks, showcaseBooksToCrossMediaPlan } from '../src/showcase-books.ts';

type Row = Record<string, unknown>;

const book = (id: number, name: string, nameCn: string, series: boolean, infobox = ''): Row => ({
  id,
  type: 1,
  name,
  name_cn: nameCn,
  platform: 1002,
  series,
  infobox: `{{Infobox animanga/Novel\r\n|中文名= ${nameCn}\r\n${infobox}}}`,
});

const bookGirlVolumes = [
  [26, '“文学少女”と死にたがりの道化', '“文学少女”与渴望死亡的小丑'],
  [27, '“文学少女”と飢え渇く幽霊', '“文学少女”与渴求真爱的幽灵'],
  [78, '“文学少女”と神に臨む作家 上', '“文学少女”与迈向神境的作家 上'],
  [79, '“文学少女”と穢名の天使', '“文学少女”与背负污名的天使'],
  [80, '“文学少女”と慟哭の巡礼者', '“文学少女”与绝望恸哭的信徒'],
  [81, '“文学少女”と月花を孕く水妖', '“文学少女”与怀抱花月的水妖'],
  [82, '“文学少女”と繋がれた愚者', '“文学少女”与沉陷过往的愚者'],
  [852, '“文学少女”と神に臨む作家 下', '“文学少女”与迈向神境的作家 下'],
] as const;

function sourceTables(
  options: {
    karaOrdinals?: readonly [number | undefined, number | undefined];
    includePublisher?: boolean;
    includeAnime?: boolean;
    unsupportedRole?: boolean;
    invalidCreatorIdentity?: boolean;
  } = {},
): CrossMediaTables {
  const subjects: Row[] = [
    book(499, '文学少女', '文学少女', true, '|作者= 野村美月\r\n|插图= 竹岡美穂\r\n|出版社= エンターブレイン\r\n'),
    ...bookGirlVolumes.map(([id, name, nameCn]) => book(id, name, nameCn, false)),
    book(2815, '空の境界', '空之境界', true, '|作者= 奈須きのこ\r\n|插图= 武内崇\r\n|出版社= 講談社\r\n|册数= 2册\r\n'),
    book(
      5329,
      '空の境界 (上)',
      '空之境界 (上)',
      false,
      '|作者= 奈須きのこ\r\n|插图= 武内崇\r\n|出版社= 講談社\r\n|页数= 448\r\n|ISBN= 9784061823617\r\n',
    ),
    book(
      10862,
      '空の境界 (下)',
      '空之境界 (下)',
      false,
      '|作者= 奈須きのこ\r\n|插图= 武内崇\r\n|出版社= 講談社\r\n|页数= 538\r\n|ISBN= 9784061823624\r\n',
    ),
    ...(options.includeAnime === false
      ? []
      : [
          {
            id: 233,
            type: 2,
            name: '劇場版 空の境界 第一章 俯瞰風景',
            name_cn: '剧场版 空之境界 第一章 俯瞰风景',
            platform: 3,
            series: false,
            infobox: '{{Infobox animanga/Movie}}',
          },
        ]),
  ];
  const relations: Row[] = [
    ...bookGirlVolumes.flatMap(([id], index) => [
      { subject_id: id, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: id, relation_type: 1003, order: [0, 2, 7, 4, 5, 6, 3, 8][index] },
    ]),
    { subject_id: 2819, related_subject_id: 2815, relation_type: 1002, order: 0 },
    { subject_id: 2820, related_subject_id: 2815, relation_type: 1002, order: 0 },
    { subject_id: 5329, related_subject_id: 2815, relation_type: 1002, order: 0 },
    { subject_id: 10862, related_subject_id: 2815, relation_type: 1002, order: 0 },
    ...(options.karaOrdinals === undefined || options.karaOrdinals[0] !== undefined
      ? [{ subject_id: 2815, related_subject_id: 5329, relation_type: 1003, order: options.karaOrdinals?.[0] ?? 1 }]
      : []),
    ...(options.karaOrdinals === undefined || options.karaOrdinals[1] !== undefined
      ? [{ subject_id: 2815, related_subject_id: 10862, relation_type: 1003, order: options.karaOrdinals?.[1] ?? 2 }]
      : []),
    { subject_id: 2815, related_subject_id: 233, relation_type: 1, order: 1 },
    { subject_id: 233, related_subject_id: 2815, relation_type: 1, order: 0 },
    { subject_id: 2815, related_subject_id: 766, relation_type: 1, order: 4 },
    { subject_id: 766, related_subject_id: 2815, relation_type: 1, order: 0 },
  ];
  const subjectPersons: Row[] = [
    { subject_id: 2815, person_id: 1466, position: 2001, appear_eps: '' },
    { subject_id: 2815, person_id: 1467, position: 2003, appear_eps: '' },
    ...(options.includePublisher === false
      ? []
      : [{ subject_id: 2815, person_id: 128, position: 2004, appear_eps: '' }]),
    ...(options.unsupportedRole ? [{ subject_id: 2815, person_id: 9999, position: 2006, appear_eps: '' }] : []),
    ...(options.invalidCreatorIdentity ? [{ subject_id: 2815, person_id: 0, position: 2001, appear_eps: '' }] : []),
  ];
  const persons: Row[] = [
    {
      id: 1466,
      type: 1,
      name: '奈須きのこ',
      name_cn: null,
      career: [],
      infobox: '{{Infobox Crt\r\n|简体中文名= 奈须蘑菇\r\n}}',
    },
    {
      id: 1467,
      type: 1,
      name: '武内崇',
      name_cn: null,
      career: [],
      infobox: '{{Infobox Crt\r\n|简体中文名= 武内崇\r\n}}',
    },
    { id: 128, type: 2, name: '講談社', name_cn: null, infobox: '{{Infobox Crt\r\n|简体中文名= 讲谈社\r\n}}' },
  ];
  const data: Record<string, Row[]> = {
    'bangumi/subject': subjects,
    'bangumi/subject-relations': relations,
    'bangumi/subject-persons': subjectPersons,
    'bangumi/person': persons,
  };
  return {
    async *rows(provider, table) {
      yield* data[`${provider}/${table}`] ?? [];
    },
  };
}

test('keeps both pinned book families, supported credits and only the selected anime endpoint', async () => {
  const planned = await planShowcaseBooks({ tables: sourceTables() });
  expect(planned.families.map((family) => [family.id, family.seriesId])).toEqual([
    ['book-girl', '499'],
    ['kara-no-kyoukai', '2815'],
  ]);
  expect(planned.selected.series).toEqual(['499', '2815']);
  expect(planned.selected.volumes).toEqual(['26', '27', '82', '79', '80', '81', '78', '852', '5329', '10862']);
  expect(planned.selected.editions).toEqual([]);
  expect(planned.selected.authors).toEqual(['person:1466']);
  expect(planned.selected.illustrators).toEqual(['person:1467']);
  expect(planned.selected.publishers).toEqual(['person:128']);
  expect(planned.selected.anime).toEqual(['233']);
  expect(planned.records.map((record) => record.key)).toEqual([
    '499',
    '26',
    '27',
    '78',
    '79',
    '80',
    '81',
    '82',
    '852',
    '2815',
    '5329',
    '10862',
    '233',
  ]);
  expect(planned.records.find((record) => record.key === '2815')?.payload).toMatchObject({
    name: '空の境界',
    name_cn: '空之境界',
  });
  expect(planned.records.find((record) => record.key === '5329')?.payload).toMatchObject({
    name: '空の境界 (上)',
    name_cn: '空之境界 (上)',
  });
  expect(planned.records.find((record) => record.key === '10862')?.payload).toMatchObject({
    name: '空の境界 (下)',
    name_cn: '空之境界 (下)',
  });
  const upperVolume = planned.records.find((record) => record.key === '5329')!;
  const upperConversion = convertBangumi(
    { external_id: upperVolume.key, record_revision: upperVolume.revision, record: upperVolume.payload },
    { subjectId: '00000000-0000-4000-8000-000000005329', source: 'bangumi' },
  );
  expect(
    upperConversion.proposals.some(
      (command) =>
        command.op === 'propose' &&
        ['schema:wordCount', 'schema:numberOfPages'].includes(command.statement.property.id),
    ),
  ).toBe(false);
  expect(upperConversion.diagnostics).toContainEqual({
    pointer: '/infobox/页数',
    code: 'edition_assertion_withheld_on_work',
  });
  expect(planned.conversions.map((conversion) => [conversion.key, conversion.grain])).toEqual([
    ['499', 'schema:BookSeries'],
    ['26', 'schema:Book'],
    ['27', 'schema:Book'],
    ['78', 'schema:Book'],
    ['79', 'schema:Book'],
    ['80', 'schema:Book'],
    ['81', 'schema:Book'],
    ['82', 'schema:Book'],
    ['852', 'schema:Book'],
    ['2815', 'schema:BookSeries'],
    ['5329', 'schema:Book'],
    ['10862', 'schema:Book'],
  ]);
  const orderedVolumes = planned.edges
    .filter((edge) => edge.property === 'wdt:P179' && ['5329', '10862'].includes(edge.holder))
    .map((edge) => [edge.holder, edge.target, edge.relation?.order]);
  expect(orderedVolumes).toEqual([
    ['5329', '2815', 1],
    ['10862', '2815', 2],
  ]);
  const animeEdge = planned.edges.find((edge) => edge.property === 'rezics:crossMediaCounterpart');
  expect(animeEdge?.relation).toMatchObject({
    code: 1,
    sourceSubject: '2815',
    sourceEndpoint: '233',
  });
  expect(animeEdge?.relation?.evidence.map((row) => row.path)).toEqual([
    '/subject-relations/2815/233',
    '/subject-relations/233/2815',
  ]);
  expect(planned.relationScope).not.toContain('766');
  expect(planned.credits.map((draft) => [draft.person, draft.roleCode])).toEqual([
    ['person:1466', 2001],
    ['person:1467', 2003],
    ['person:128', 2004],
  ]);
  const crossMedia = showcaseBooksToCrossMediaPlan(planned);
  expect(crossMedia.members.find((member) => member.key === '233')).toMatchObject({
    kind: 'work',
    membership: 'referenced',
  });
  expect(crossMedia.members.find((member) => member.key === 'person:128')).toMatchObject({
    kind: 'organization',
    membership: 'referenced',
  });
  expect(planned.members.filter((member) => member.role === 'missing').map((member) => member.key)).toEqual([
    '2819',
    '2820',
  ]);
});

test('keeps unknown or ambiguous ordinals and missing evidence distinct without inventing publishers or editions', async () => {
  const unknown = await planShowcaseBooks({
    tables: sourceTables({ includePublisher: false, unsupportedRole: true, karaOrdinals: [undefined, undefined] }),
  });
  expect(unknown.selected.volumes).toContain('10862');
  expect(unknown.edges.find((edge) => edge.property === 'wdt:P179' && edge.holder === '10862')?.relation?.order).toBe(
    undefined,
  );
  expect(unknown.gaps).toContainEqual(
    expect.objectContaining({ reason: 'Source volume ordinal is unknown', endpoint: '10862' }),
  );
  expect(unknown.gaps).toContainEqual(
    expect.objectContaining({ reason: 'Unsupported creator role on selected book record', code: '2006' }),
  );
  expect(unknown.selected.publishers).toEqual([]);
  expect(unknown.creators.some((record) => record.key === 'person:128')).toBe(false);
  expect(unknown.credits.some((draft) => draft.roleCode === 2004)).toBe(false);
  expect(unknown.selected.editions).toEqual([]);
  expect(unknown.conversions.every((conversion) => conversion.grain !== 'bf:Instance')).toBe(true);

  const ambiguous = await planShowcaseBooks({ tables: sourceTables({ karaOrdinals: [1, 1] }) });
  expect(
    ambiguous.gaps.filter((item) => item.reason === 'Source volume ordinal is ambiguous across volumes'),
  ).toHaveLength(2);
  expect(
    ambiguous.edges
      .filter((edge) => edge.property === 'wdt:P179' && ['5329', '10862'].includes(edge.holder))
      .every((edge) => edge.relation?.order === undefined),
  ).toBe(true);

  const missingAnime = await planShowcaseBooks({ tables: sourceTables({ includeAnime: false }) });
  expect(missingAnime.gaps).toContainEqual(
    expect.objectContaining({ reason: 'Selected anime relation endpoint is missing from the dump', endpoint: '233' }),
  );
  expect(missingAnime.selected.anime).toEqual([]);

  const invalidCreator = await planShowcaseBooks({ tables: sourceTables({ invalidCreatorIdentity: true }) });
  expect(invalidCreator.gaps).toContainEqual(
    expect.objectContaining({
      reason: 'Creator identity key is invalid on selected book record',
      property: 'schema:author',
    }),
  );
});
