import { describe, expect, test } from 'bun:test';
import {
  projectDatasetFields,
  type DatasetFieldPlan,
} from '../../../scripts/datasets/native/fields.ts';
import {
  datasetRecordDigest,
  datasetSourceIdentity,
} from '../../../scripts/datasets/native/context.ts';
import { canonical, sha256 } from '../../../scripts/datasets/store.ts';
import type { DatasetRecord, DatasetSourceReference } from '../../../scripts/datasets/types.ts';
import { checkedSemanticValue } from '../../../services/main/src/modules/semantic/value.ts';

const SCHEMA = 'https://schema.org/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const record = (overrides: Partial<DatasetRecord> = {}): DatasetRecord => ({
  key: 'bangumi:character:402',
  provider: 'bangumi',
  kind: 'character',
  externalId: '402',
  title: '原名',
  language: 'ja',
  sourceUrl: 'https://bgm.tv/character/402',
  native: 'character',
  data: {},
  ...overrides,
});
const source = (input: DatasetRecord): DatasetSourceReference => {
  const reference = {
    key: input.key,
    provider: input.provider,
    namespace: input.kind,
    externalId: input.externalId,
    snapshot: 'frozen-shape',
    snapshotDigest: 'a'.repeat(64),
    recordDigest: datasetRecordDigest(input),
    // Retained intake may have multiple parts; no part is silently made the whole record.
    observations: [
      'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
      'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    ],
    intakes: [1, 2].map((index) => ({
      record: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
      observation: `https://rezics.com/id/00000000-0000-4000-8000-00000000000${index}`,
      byteDigest: String(index).repeat(64),
    })),
  };
  return reference;
};
const project = (overrides: Partial<DatasetRecord>) => {
  const input = record(overrides);
  return projectDatasetFields(input, source(input));
};
const at = (plan: DatasetFieldPlan, path: string) =>
  plan.fields.filter((field) => field.evidence.some((evidence) => evidence.path === path));
const valueAt = (plan: DatasetFieldPlan, path: string) =>
  at(plan, path)[0]?.native?.property?.value;

describe('source field projection over retained shapes', () => {
  test('VN original language is a supported native fact, independent of title and alias language', () => {
    const input = record({ key: 'vndb:vn:v11', provider: 'vndb', kind: 'vn', externalId: 'v11',
      native: 'work', language: 'en', sourceUrl: 'https://vndb.org/v11',
      data: { olang: 'ja', alias: 'Exact alias' } });
    const reference = source(input);
    const plan = projectDatasetFields(input, reference);
    expect(at(plan, '/data/olang')).toEqual([expect.objectContaining({
      role: 'original-language', presence: 'value', disposition: 'candidate',
      evidence: [expect.objectContaining({ source: reference, path: '/data/olang',
        valueDigest: sha256(canonical('ja')) })],
      native: expect.objectContaining({ owner: 'semantic', material: 'fact',
        property: { predicate: `${SCHEMA}inLanguage`, value: { kind: 'string', lexical: 'ja' } } }),
    })]);
    expect(valueAt(plan, '/title')).toMatchObject({ language: 'en' });
    expect(at(plan, '/data/alias')[0]?.native).toBeUndefined();
    expect(at(plan, '/data/alias')[0]?.evidence[0]?.language).toBeUndefined();
    for (const [presence, data] of [['omitted', {}], ['null', { olang: null }],
      ['empty-string', { olang: '' }]] as const) {
      const absent = projectDatasetFields({ ...input, data }, source({ ...input, data }));
      const field = at(absent, '/data/olang')[0]!;
      expect(field.presence).toBe(presence);
      expect(field.native).toBeUndefined();
      expect(field.evidence[0]!.valueDigest).toBe(presence === 'omitted'
        ? undefined : sha256(canonical('olang' in data ? data.olang : undefined)));
    }
    expect(at(project({ provider: 'vndb', kind: 'producer', native: 'organization',
      data: { lang: 'de', olang: 'ja' } }), '/data/olang').some(field => field.native)).toBe(false);
  });

  test('retained Episode placement fields preserve exact source presence and remain occurrence candidates', () => {
    const plan = project({
      kind: 'episode',
      native: 'episode',
      data: { sort: 0.5, disc: 0, type: 1 },
    });
    for (const [field, name, raw] of [
      ['sort', 'position', 0.5],
      ['disc', 'disc', 0],
      ['type', 'kindCode', 1],
    ] as const) {
      expect(at(plan, `/data/${field}`)[0]).toMatchObject({
        disposition: 'candidate',
        presence: 'value',
        evidence: [{ path: `/data/${field}`, valueDigest: sha256(canonical(raw)) }],
        native: {
          owner: 'structure',
          occurrenceField: name,
          predicate: `qualifier.values.${name}`,
          material: 'fact',
        },
      });
    }
    expect(
      plan.fields.some((field) => field.native?.predicate === 'https://schema.org/episodeNumber'),
    ).toBe(false);
    for (const raw of [undefined, null, '', -1, ' 0.5', true, '0.3333333333333']) {
      const data = raw === undefined ? {} : { sort: raw, disc: raw, type: raw };
      const candidate = project({ kind: 'episode', native: 'episode', data });
      for (const field of ['sort', 'disc', 'type']) {
        expect(at(candidate, `/data/${field}`)[0]?.native).toBeUndefined();
        expect(at(candidate, `/data/${field}`)[0]?.presence).toBe(
          raw === undefined
            ? 'omitted'
            : raw === null
              ? 'null'
              : raw === ''
                ? 'empty-string'
                : 'value',
        );
      }
    }
    const fraction = project({
      kind: 'episode',
      native: 'episode',
      data: { sort: '0.5', disc: 0.5, type: 0.5 },
    });
    expect(at(fraction, '/data/sort')[0]?.native?.owner).toBe('structure');
    expect(at(fraction, '/data/disc')[0]?.native).toBeUndefined();
    expect(at(fraction, '/data/type')[0]?.native).toBeUndefined();
  });

  test('genuine editions consume release-owned scalar correspondence without reducing precision or title language', () => {
    const input = record({ key: 'vndb:release:r14',provider: 'vndb',kind: 'release',externalId: 'r14',
      native: 'release',title: 'Exact edition',language: 'EN-us',sourceUrl: 'https://vndb.org/r14',
      data: { released: '20049999',official: false,tables: { releases_platforms: [{ platform: 'win' }],
        releases_titles: [{ lang: 'ja',mtl: false }],releases_vn: [{ vid: 'v11',rtype: 'complete' }] } } });
    const plan = projectDatasetFields(input,source(input));
    const owned = (path: string,owner: 'release' | 'realization') => at(plan,path).find(field => field.native?.owner === owner);
    expect(owned('/title','release')).toMatchObject({ disposition: 'candidate',
      evidence: [{ path: '/title',language: 'EN-us',valueDigest: sha256(canonical('Exact edition')) }],
      native: { property: { value: { kind: 'language-string',lexical: 'Exact edition',language: 'en-US' } } } });
    expect(owned('/data/released','release')?.native?.property?.value).toEqual({
      kind: 'temporal',lexical: '2004',precision: 'year',calendar: 'gregorian' });
    expect(owned('/data/official','release')).toMatchObject({
      evidence: [{ valueDigest: sha256(canonical(false)) }],native: { property: {
        predicate: 'https://rezics.com/vocab/releaseStatus',value: { kind: 'string',lexical: 'unofficial' } } } });
    expect(owned('/data/tables/releases_platforms/0/platform','release')?.native?.property?.value)
      .toEqual({ kind: 'string',lexical: 'win' });
    expect(owned('/data/tables/releases_titles/0/lang','realization')?.native?.property?.value)
      .toEqual({ kind: 'string',lexical: 'ja' });
    expect(owned('/data/tables/releases_titles/0/mtl','realization')).toBeUndefined();
    const exactMonth = structuredClone(input); exactMonth.data.released = '20040399';
    expect(at(projectDatasetFields(exactMonth,source(exactMonth)),'/data/released')
      .some(field => field.native?.owner === 'release')).toBe(false);
    const descriptive = { ...input,native: 'work' as const,semanticTypes: ['https://schema.org/PublicationEvent'] };
    expect(projectDatasetFields(descriptive,source(descriptive)).fields
      .some(field => ['release','realization'].includes(field.native?.owner ?? ''))).toBe(false);
  });

  test('readable Work synopsis uses its editorial owner and names use metadata', () => {
    const plan = project({
      kind: 'subject',
      native: 'work',
      data: {
        summary: '作品简介。',
        name_cn: '中文作品名',
        eps: 12,
      },
    });
    expect(at(plan, '/data/summary')[0]).toMatchObject({
      disposition: 'candidate',
      native: {
        owner: 'work-editorial',
        material: 'expression',
        property: {
          predicate: `${SCHEMA}description`,
          value: {
            kind: 'language-string',
            lexical: '作品简介。',
            language: 'zh-Hans',
          },
        },
      },
    });
    expect(at(plan, '/title')[0]!.native).toMatchObject({
      owner: 'work-metadata',
      property: { value: { lexical: '原名', language: 'ja' } },
    });
    expect(at(plan, '/data/name_cn')[0]!.native).toMatchObject({
      owner: 'work-metadata',
      property: { value: { lexical: '中文作品名', language: 'zh-Hans' } },
    });
    expect(at(plan, '/data/eps')[0]!.native).toMatchObject({ owner: 'semantic', material: 'fact' });
  });

  test('positive synopsis, names and aliases keep their own language, source pointer and exact attribution', () => {
    const input = record({
      data: {
        name: '原名',
        name_cn: '中文名',
        summary: '第一行。\n第二行。',
        infobox: [{ key: '别名', value: [{ v: 'Another name' }, { v: '別称' }] }],
        api_subject: { summary: 'A separately qualified summary.', summary_language: 'en-GB' },
      },
    });
    const reference = source(input);
    const plan = projectDatasetFields(input, reference);
    expect(valueAt(plan, '/title')).toEqual({
      kind: 'language-string',
      lexical: '原名',
      language: 'ja',
    });
    expect(valueAt(plan, '/data/name_cn')).toEqual({
      kind: 'language-string',
      lexical: '中文名',
      language: 'zh-Hans',
    });
    expect(valueAt(plan, '/data/summary')).toEqual({
      kind: 'language-string',
      lexical: '第一行。\n第二行。',
      language: 'zh-Hans',
    });
    expect(at(plan, '/data/summary')[0]).toMatchObject({
      disposition: 'candidate',
      native: { owner: 'semantic', predicate: `${SCHEMA}description`, material: 'expression' },
      evidence: [
        {
          source: reference,
          sourceUrl: input.sourceUrl,
          language: 'zh-Hans',
          path: '/data/summary',
          valueDigest: sha256(canonical(input.data.summary)),
        },
      ],
    });
    expect(valueAt(plan, '/data/infobox/0/value/0/v')).toEqual({
      kind: 'string',
      lexical: 'Another name',
    });
    expect(valueAt(plan, '/data/infobox/0/value/1/v')).toEqual({ kind: 'string', lexical: '別称' });
    expect(valueAt(plan, '/data/api_subject/summary')).toEqual({
      kind: 'language-string',
      lexical: 'A separately qualified summary.',
      language: 'en-GB',
    });
    expect(
      plan.fields.filter((field) => field.role === 'description' && field.native),
    ).toHaveLength(2);
  });

  test('omitted, null and each empty shape remain distinct evidence, never deletion or guessed prose', () => {
    const values: [unknown, string][] = [
      [null, 'null'],
      ['', 'empty-string'],
      [[], 'empty-array'],
      [{}, 'empty-object'],
    ];
    const omitted = at(project({ data: {} }), '/data/summary')[0]!;
    expect(omitted).toMatchObject({ presence: 'omitted', disposition: 'source-only' });
    expect(omitted.evidence[0]).not.toHaveProperty('valueDigest');
    const digests = new Set<string>();
    for (const [summary, state] of values) {
      const field = at(project({ data: { summary } }), '/data/summary')[0]!;
      expect(field).toMatchObject({ presence: state, disposition: 'source-only' });
      expect(field.native).toBeUndefined();
      expect(field.evidence[0]!.valueDigest).toBe(sha256(canonical(summary)));
      digests.add(field.evidence[0]!.valueDigest!);
    }
    expect(digests.size).toBe(values.length);
    const plan = project({ data: { summary: 'Unlabelled expression.', summary_language: null } });
    expect(valueAt(plan, '/data/summary')).toEqual({
      kind: 'string',
      lexical: 'Unlabelled expression.',
    });
    expect(at(plan, '/data/summary')[0]!.evidence[0]).toHaveProperty('language', null);
  });

  test('VNDB scalar aliases do not inherit the Work language; table names retain supplied language and Latin script', () => {
    const input = record({
      provider: 'vndb',
      kind: 'character',
      externalId: 'c1',
      key: 'vndb:character:c1',
      sourceUrl: 'https://vndb.org/c1',
      data: {
        description: 'An exact character synopsis.',
        description_language: 'en',
        alias: ' English alias \r\n日本語の別名',
        tables: {
          chars_names: [{ name: '名前', latin: 'Namae', lang: 'ja-Hani' }],
          chars_alias: [{ name: 'Literal alias' }],
        },
      },
    });
    const plan = projectDatasetFields(input, source(input));
    expect(at(plan, '/data/alias').map((field) => field.native?.property?.value)).toEqual([
      { kind: 'string', lexical: ' English alias ' },
      { kind: 'string', lexical: '日本語の別名' },
    ]);
    expect(at(plan, '/data/alias').map((field) => field.evidence[0]!.ordinal)).toEqual([0, 1]);
    expect(
      at(plan, '/data/alias').every(
        (field) => field.evidence[0]!.valueDigest === sha256(canonical(input.data.alias)),
      ),
    ).toBe(true);
    expect(valueAt(plan, '/data/tables/chars_names/0/name')).toEqual({
      kind: 'language-string',
      lexical: '名前',
      language: 'ja-Hani',
    });
    expect(valueAt(plan, '/data/tables/chars_names/0/latin')).toEqual({
      kind: 'language-string',
      lexical: 'Namae',
      language: 'ja-Latn',
    });
    expect(at(plan, '/data/tables/chars_names/0/latin')[0]!.evidence[0]!.language).toBe('ja-Hani');
    expect(valueAt(plan, '/data/tables/chars_alias/0/name')).toEqual({
      kind: 'string',
      lexical: 'Literal alias',
    });
    expect(valueAt(plan, '/data/description')).toEqual({
      kind: 'language-string',
      lexical: 'An exact character synopsis.',
      language: 'en',
    });
    expect(at(plan, '/data/tables/chars_names')).toHaveLength(0);
  });

  test('exact measured facts retain units and decimal evidence; zero sentinels and unsafe numbers stay explicit', () => {
    const plan = project({
      provider: 'vndb',
      data: {
        height: '165.5000',
        weight: 0,
        b_month: 2,
        b_day: 29,
        bust: '80',
        gender: 'f',
        traits: [{ id: 'i1' }],
      },
    });
    expect(valueAt(plan, '/data/height')).toEqual({
      kind: 'quantity',
      lexical: '165.5000',
      value: { kind: 'decimal', lexical: '165.5' },
      unit: 'http://qudt.org/vocab/unit/CentiM',
    });
    expect(at(plan, '/data/weight')[0]).toMatchObject({
      disposition: 'source-only',
      presence: 'value',
    });
    expect(at(plan, '/data/b_month')[0]).toMatchObject({
      disposition: 'candidate',
      native: {
        owner: 'statement',
        statementValue: {
          kind: 'literal',
          lexical: '--02-29',
          datatype: `${XSD}gMonthDay`,
          language: null,
        },
      },
    });
    expect(at(plan, '/data/b_month')[0]!.native?.property).toBeUndefined();
    expect(at(plan, '/data/traits')[0]!.disposition).toBe('delegated');
    expect(at(plan, '/data/gender')[0]!.native).toBeUndefined();
    expect(at(plan, '/data/bust')[0]!.native).toBeUndefined();
    const partial = project({ provider: 'vndb', data: { b_month: 2 } });
    expect(at(partial, '/data/b_month')[0]!.native).toBeUndefined();
    expect(at(partial, '/data/b_month')[0]!.evidence[1]).not.toHaveProperty('valueDigest');
    for (const length of [1.25, Number.MAX_SAFE_INTEGER + 1, -1]) {
      expect(
        at(
          project({ provider: 'musicbrainz', kind: 'recording', native: 'work', data: { length } }),
          '/data/length',
        )[0],
      ).toMatchObject({ disposition: 'unmapped' });
    }
    const measured = project({
      provider: 'musicbrainz',
      kind: 'recording',
      native: 'work',
      data: {
        length: '9007199254740993.0100',
        isrcs: ['GBABC2600001'],
        disambiguation: 'studio take',
      },
    });
    expect(valueAt(measured, '/data/length')).toEqual({
      kind: 'quantity',
      lexical: '9007199254740993.0100',
      value: { kind: 'decimal', lexical: '9007199254740993.01' },
      unit: 'http://qudt.org/vocab/unit/MilliSEC',
    });
    expect(valueAt(measured, '/data/isrcs/0')).toEqual({ kind: 'string', lexical: 'GBABC2600001' });
    expect(valueAt(measured, '/data/disambiguation')).toEqual({
      kind: 'string',
      lexical: 'studio take',
    });
    expect(
      valueAt(
        project({ provider: 'musicbrainz', kind: 'recording', data: { length: 0 } }),
        '/data/length',
      ),
    ).toMatchObject({ kind: 'quantity', value: { kind: 'integer', lexical: '0' } });
  });

  test('partial publication dates keep precision without inventing a month, day or time zone', () => {
    for (const [released, lexical, precision] of [
      [20049999, '2004', 'year'],
      [20040299, '2004-02', 'month'],
      [20040229, '2004-02-29', 'day'],
    ] as const) {
      expect(
        valueAt(
          project({ provider: 'vndb', kind: 'vn', native: 'work', data: { released } }),
          '/data/released',
        ),
      ).toEqual({ kind: 'temporal', lexical, precision, calendar: 'gregorian' });
    }
    for (const released of [0, 99999999])
      expect(
        at(project({ provider: 'vndb', kind: 'release', data: { released } }), '/data/released')[0]!
          .disposition,
      ).toBe('source-only');
    for (const released of [20049901, 20030229, 20041399])
      expect(
        at(project({ provider: 'vndb', kind: 'vn', data: { released } }), '/data/released')[0]!
          .disposition,
      ).toBe('unmapped');
    const artist = project({
      provider: 'musicbrainz',
      kind: 'artist',
      native: 'person',
      data: {
        'life-span': { begin: '1984-02', end: null, ended: false },
        area: { id: 'area-id', name: 'York' },
      },
    });
    expect(valueAt(artist, '/data/life-span/begin')).toEqual({
      kind: 'temporal',
      lexical: '1984-02',
      precision: 'month',
      calendar: 'gregorian',
    });
    expect(at(artist, '/data/life-span/end')[0]!.presence).toBe('null');
    expect(at(artist, '/data/life-span/ended')[0]!.native).toBeUndefined();
    expect(valueAt(artist, '/data/area/name')).toEqual({ kind: 'string', lexical: 'York' });
    expect(at(artist, '/data/area/id')[0]!.disposition).toBe('unmapped');
    const episode = project({
      kind: 'episode',
      native: 'episode',
      data: { airdate: '2026-10-19', sort: '12.5', duration: '00:24:00' },
    });
    expect(valueAt(episode, '/data/airdate')).toMatchObject({ kind: 'temporal', precision: 'day' });
    expect(valueAt(episode, '/data/sort')).toEqual({ kind: 'decimal', lexical: '12.5' });
    expect(valueAt(episode, '/data/duration')).toEqual({ kind: 'string', lexical: '00:24:00' });
  });

  test('MusicBrainz null and omitted alias locales remain distinct and annotations stay separate from synopsis', () => {
    const plan = project({
      provider: 'musicbrainz',
      kind: 'label',
      native: 'organization',
      data: {
        aliases: [
          { name: 'Label', locale: 'en-us' },
          { name: '標籤', locale: null },
          { name: 'Unlabelled' },
        ],
        'sort-name': 'Label, The',
        'label-code': 123,
        annotation: 'Exact annotation.',
        'life-span': { begin: '1978' },
        country: 'GB',
      },
    });
    expect(valueAt(plan, '/data/aliases/0/name')).toEqual({
      kind: 'language-string',
      lexical: 'Label',
      language: 'en-US',
    });
    expect(at(plan, '/data/aliases/0/name')[0]!.evidence[0]!.language).toBe('en-us');
    expect(at(plan, '/data/aliases/1/name')[0]!.evidence[0]).toHaveProperty('language', null);
    expect(at(plan, '/data/aliases/2/name')[0]!.evidence[0]).not.toHaveProperty('language');
    expect(valueAt(plan, '/data/label-code')).toEqual({ kind: 'integer', lexical: '123' });
    expect(valueAt(plan, '/data/life-span/begin')).toMatchObject({
      kind: 'temporal',
      precision: 'year',
    });
    expect(at(plan, '/data/annotation')[0]!.native).toMatchObject({
      predicate: 'http://www.w3.org/2000/01/rdf-schema#comment',
      material: 'expression',
    });
    expect(
      plan.fields.filter((field) => field.role === 'description' && field.native),
    ).toHaveLength(0);
    const composition = project({
      provider: 'musicbrainz',
      kind: 'work',
      native: 'work',
      data: { iswcs: ['T-000.000.001-0'], language: 'jpn' },
    });
    expect(valueAt(composition, '/data/iswcs/0')).toEqual({
      kind: 'string',
      lexical: 'T-000.000.001-0',
    });
    expect(valueAt(composition, '/data/language')).toEqual({ kind: 'string', lexical: 'jpn' });
  });

  test('activity, user expression, raw JSON and unreviewed facts never become a fake description', () => {
    const plan = project({
      data: {
        summary: { nested: 'not a synopsis string' },
        rating: { score: 9, total: 200 },
        collection: { wish: 100 },
        comments: ['User text'],
        images: { large: 'https://example.test/image.png' },
        traits: ['unreviewed'],
        'new/field~name': { count: 7 },
        eps: 12,
        volumes: 0,
      },
    });
    expect(at(plan, '/data/summary')[0]!.disposition).toBe('unmapped');
    for (const path of ['/data/rating', '/data/collection', '/data/comments', '/data/images']) {
      expect(at(plan, path)[0]!.disposition).toBe('source-only');
      expect(at(plan, path)[0]!.native).toBeUndefined();
    }
    expect(at(plan, '/data/new~1field~0name/count')[0]!.disposition).toBe('unmapped');
    expect(valueAt(plan, '/data/eps')).toEqual({ kind: 'integer', lexical: '12' });
    expect(at(plan, '/data/volumes')[0]!.disposition).toBe('source-only');
    expect(plan.fields.some((field) => field.native?.predicate === `${SCHEMA}description`)).toBe(
      false,
    );
    expect(
      project({ kind: 'review', data: { summary: 'User review', name: 'Review name' } }).fields,
    ).toMatchObject([{ disposition: 'source-only', evidence: [{ path: '/data' }] }]);
  });

  test('native text bounds are explicit; aliases are not sliced to a command limit', () => {
    for (const summary of ['a'.repeat(9000), 'First line.\r\nSecond line.']) {
      const plan = project({ kind: 'subject', native: 'work', data: { summary } });
      expect(at(plan, '/data/summary')[0]).toMatchObject({
        disposition: 'candidate',
        evidence: [{ valueDigest: sha256(canonical(summary)) }],
      });
      expect(at(plan, '/data/summary')[0]!.native).toMatchObject({ owner: 'work-editorial',
        property: { value: { lexical: summary } } });
    }
    expect(
      at(
        project({
          kind: 'subject',
          native: 'work',
          data: { summary: 'Unlabelled', summary_language: null },
        }),
        '/data/summary',
      )[0]!.disposition,
    ).toBe('candidate');
    const tooLarge = 'x'.repeat(1_048_577);
    const retained = at(project({ kind: 'subject', native: 'work', data: { summary: tooLarge } }), '/data/summary')[0]!;
    expect(retained.disposition).toBe('unmapped');
    expect(retained.evidence[0]?.valueDigest).toBe(sha256(canonical(tooLarge)));
    const synopsis = 'x'.repeat(5000);
    const supporting = at(project({ data: { summary: synopsis } }), '/data/summary')[0]!;
    expect(supporting.native?.property?.value).toMatchObject({ lexical: synopsis });
    expect(supporting.native?.statementValue).toBeUndefined();
    const aliases = Array.from({ length: 12 }, (_, index) => ({
      name: `Alias ${index}`,
      locale: 'fr',
    }));
    const plan = project({
      provider: 'musicbrainz',
      kind: 'work',
      native: 'work',
      data: { aliases },
    });
    expect(plan.fields.filter((field) => field.role === 'aliases' && field.native)).toHaveLength(
      12,
    );
  });

  test('source identity is stable across snapshots and copies cannot erase retained evidence or mutate input', () => {
    const input = record({ data: { summary: 'Same exact summary.' } }),
      reference = source(input);
    const original = canonical({ input, reference });
    const plan = projectDatasetFields(input, reference);
    expect(projectDatasetFields(input, reference)).toEqual(plan);
    expect(plan.source).not.toBe(reference);
    expect(plan.fields[0]!.evidence[0]!.source).not.toBe(reference);
    for (const field of plan.fields) {
      if (field.native?.property)
        expect(checkedSemanticValue(field.native.property.value)).toEqual(
          field.native.property.value,
        );
      expect(field).not.toHaveProperty('receipt');
      expect(field).not.toHaveProperty('adopted');
    }
    expect(canonical({ input, reference })).toBe(original);
    const later = projectDatasetFields(input, {
      ...reference,
      snapshot: 'next-snapshot',
      snapshotDigest: 'b'.repeat(64),
    });
    expect(later.fields.map((field) => field.native)).toEqual(
      plan.fields.map((field) => field.native),
    );
    expect(datasetSourceIdentity(input)).toBe(
      canonical([input.provider, input.kind, input.externalId]),
    );
    expect(() => projectDatasetFields({ ...input, title: 'changed bytes' }, reference)).toThrow(
      'exact retained source record',
    );
    expect(() => projectDatasetFields(input, { ...reference, namespace: 'person' })).toThrow(
      'exact retained source record',
    );
    expect(() => projectDatasetFields(input, { ...reference, externalId: 'other' })).toThrow(
      'exact retained source record',
    );
  });
});
