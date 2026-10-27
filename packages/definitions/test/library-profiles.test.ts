import { expect, test } from 'bun:test';
import { bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease, type Release } from '../src/index.ts';

// Proposed ABI: library-profile-design.md. Deliberately use structural assertions until implementation lands.
export const LIBRARY_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
export type ProfileData = Record<string, any>;
const stateIds = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
const stateWords = {
  de: ['Geplant', 'In Arbeit', 'Abgeschlossen', 'Pausiert', 'Abgebrochen'],
  en: ['Planned', 'In progress', 'Completed', 'Paused', 'Dropped'],
  es: ['Planeado', 'En curso', 'Completado', 'En pausa', 'Abandonado'],
  fr: ['Prévu', 'En cours', 'Terminé', 'En pause', 'Abandonné'],
  ja: ['予定', '進行中', '完了', '中断', '断念'],
  ko: ['예정', '진행 중', '완료', '일시 중지', '중단'],
  'zh-Hans': ['计划', '进行中', '已完成', '暂停', '放弃'],
  'zh-Hant': ['計劃', '進行中', '已完成', '暫停', '放棄'],
};
const unitWords: Record<string, readonly string[]> = {
  page: ['Seite', 'page', 'página', 'page', 'ページ', '쪽', '页', '頁'],
  episode: ['Folge', 'episode', 'episodio', 'épisode', 'エピソード', '에피소드', '集', '集'],
  minute: ['Minute', 'minute', 'minuto', 'minute', '分', '분', '分钟', '分鐘'],
  percent: ['Prozent', 'percent', 'porcentaje', 'pourcentage', 'パーセント', '퍼센트', '百分比', '百分比'],
};
const localized = (words: readonly string[]) => Object.fromEntries(LIBRARY_LOCALES.map((l, i) => [l, words[i]!]));

/** Inert source annotation: labels live in the declaring schema's presentation group. */
export function libraryProfile(id = 'fixture.reading', unit = 'page'): ProfileData {
  return {
    id,
    revision: 1,
    entryStateSet: {
      id: 'legacy-five',
      states: stateIds.map((id, i) => ({ id, role: ['planned', 'active', 'completed', 'paused', 'dropped'][i] })),
    },
    units: [
      {
        id: unit,
        dimension: unit === 'minute' ? 'duration' : unit === 'percent' ? 'ratio' : 'count',
        precision: unit === 'minute' || unit === 'percent' ? 6 : 0,
        minimum: 0,
        maximum: unit === 'percent' ? 100 : 999999999999,
      },
    ],
    progress: [{ mode: 'scalar_amount', units: [unit], totalPolicy: unit === 'percent' ? 'fixed_100' : 'optional' }],
    copies: [
      { id: 'physical', statuses: [{ id: 'owned' }, { id: 'disposed' }] },
      { id: 'digital', statuses: [{ id: 'owned' }] },
    ],
    importSources: [],
  };
}
export function libraryLabels(profile: ProfileData, locale: (typeof LIBRARY_LOCALES)[number]): ProfileData {
  const n = LIBRARY_LOCALES.indexOf(locale);
  return {
    profile: localized([
      'Bibliothek',
      'library',
      'biblioteca',
      'bibliothèque',
      'ライブラリ',
      '라이브러리',
      '资料库',
      '資料庫',
    ])[locale],
    stateSet: localized(['Status', 'state', 'estado', 'état', '状態', '상태', '状态', '狀態'])[locale],
    states: Object.fromEntries(
      profile.entryStateSet.states.map((s: ProfileData) => [s.id, stateWords[locale][stateIds.indexOf(s.id)] ?? s.id]),
    ),
    units: Object.fromEntries(profile.units.map((u: ProfileData) => [u.id, unitWords[u.id]?.[n] ?? u.id])),
    copyKinds: {
      physical: ['Physisch', 'physical', 'físico', 'physique', '物理', '실물', '实体', '實體'][n],
      digital: ['Digital', 'digital', 'digital', 'numérique', 'デジタル', '디지털', '数字', '數位'][n],
    },
    copyStatuses: {
      physical: {
        owned: ['Im Besitz', 'owned', 'en propiedad', 'possédé', '所持', '보유', '持有', '持有'][n],
        disposed: ['Abgegeben', 'disposed', 'retirado', 'cédé', '処分済み', '처분', '已处置', '已處置'][n],
      },
      digital: { owned: ['Im Besitz', 'owned', 'en propiedad', 'possédé', '所持', '보유', '持有', '持有'][n] },
    },
    importSources: Object.fromEntries(profile.importSources.map((s: ProfileData) => [s.id, 'manual fixture'])),
  };
}
export function compiledProfile(profile: ProfileData): ProfileData {
  const result = structuredClone(profile);
  const labels = (select: (p: ProfileData) => string) =>
    Object.fromEntries(LIBRARY_LOCALES.map((l) => [l, select(libraryLabels(profile, l))]));
  result.labels = labels((p) => p.profile);
  result.entryStateSet.labels = labels((p) => p.stateSet);
  for (const s of result.entryStateSet.states) s.labels = labels((p) => p.states[s.id]);
  for (const u of result.units) u.labels = labels((p) => p.units[u.id]);
  for (const k of result.copies) {
    k.labels = labels((p) => p.copyKinds[k.id]);
    for (const s of k.statuses) s.labels = labels((p) => p.copyStatuses[k.id][s.id]);
  }
  for (const s of result.importSources) s.labels = labels((p) => p.importSources[s.id]);
  return result;
}
export function profileOf(release: Release, type: string): ProfileData | undefined {
  return (release.types[type] as unknown as { library?: ProfileData } | undefined)?.library;
}
function fixture(profile: unknown = libraryProfile(), child?: unknown) {
  const classes: Record<string, ProfileData> = {
    Root: { abstract: true, annotations: { library: libraryProfile('fixture.root', 'percent') } },
    Parent: { class_uri: 'ex:Parent', is_a: 'Root', annotations: { library: profile } },
    Bridge: { abstract: true, is_a: 'Parent' },
    Child: {
      class_uri: 'ex:Child',
      is_a: 'Bridge',
      ...(child === undefined ? {} : { annotations: { library: child } }),
    },
    Sibling: { class_uri: 'ex:Sibling', is_a: 'Parent' },
    Person: { class_uri: 'ex:Person' },
  };
  const profiles = [classes.Root!.annotations.library, profile, child].filter(
    (p): p is ProfileData => !!p && typeof p === 'object',
  );
  return {
    root: 'fixture.yaml',
    schemas: {
      'fixture.yaml': JSON.stringify({
        id: 'https://example.org/fixture',
        name: 'fixture',
        version: '1',
        prefixes: { linkml: 'https://w3id.org/linkml/', ex: 'https://example.org/' },
        imports: ['linkml:types'],
        classes,
      }),
    },
    presentation: Object.fromEntries(
      LIBRARY_LOCALES.map((locale) => [
        `fixture/${locale}`,
        JSON.stringify({
          types: { 'ex:Parent': 'parent', 'ex:Child': 'child', 'ex:Sibling': 'sibling', 'ex:Person': 'person' },
          libraryProfiles: Object.fromEntries(profiles.map((p) => [p.id, libraryLabels(p, locale)])),
        }),
      ]),
    ),
  };
}
async function compilerErrors(input: Parameters<typeof compileCatalogue>[0]) {
  try {
    await compileCatalogue(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Malformed profile compiled');
}
function releaseWith(profile: unknown): Release {
  return {
    format: 'https://rezics.com/definitions/release/1',
    catalogue: { id: 'https://example.org/fixture', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: { ex: 'https://example.org/' },
    types: {
      'ex:Child': {
        iri: 'https://example.org/Child',
        labels: { en: 'child' },
        mappings: [],
        bases: [],
        properties: [],
        facets: [],
        library: profile,
      },
    },
    properties: {},
  } as unknown as Release;
}

test('library profiles compile as bounded inherited type data with exact stable identities', async () => {
  const source = libraryProfile();
  const input = fixture(source);
  const before = structuredClone(input);
  const release = await compileCatalogue(input);
  expect(validateRelease(release)).toEqual([]);
  expect(profileOf(release, 'ex:Child')).toEqual(compiledProfile(source));
  expect(profileOf(release, 'ex:Parent')).toEqual(compiledProfile(source));
  expect(profileOf(release, 'ex:Person')).toBeUndefined();
  expect(input).toEqual(before);
  expect(profileOf(release, 'ex:Child')!.entryStateSet.states.map((s: ProfileData) => s.id)).toEqual(stateIds);
  // No aliases between inherited values, even for nested lists.
  profileOf(release, 'ex:Child')!.copies[0].statuses.pop();
  expect(profileOf(release, 'ex:Parent')).toEqual(compiledProfile(source));
  expect(profileOf(release, 'ex:Sibling')).toEqual(compiledProfile(source));
});

test('a child profile replaces every parent list and source objects stay untouched', async () => {
  const parent = libraryProfile();
  const child = libraryProfile('fixture.child', 'percent');
  child.entryStateSet = { id: 'choice', states: [{ id: 'interested' }] };
  child.copies = [];
  const input = fixture(parent, child);
  const before = structuredClone(input);
  const release = await compileCatalogue(input);
  expect(profileOf(release, 'ex:Child')).toEqual(compiledProfile(child));
  expect(profileOf(release, 'ex:Parent')).toEqual(compiledProfile(parent));
  expect(profileOf(release, 'ex:Child')!.entryStateSet.states).toHaveLength(1);
  expect(input).toEqual(before);
  expect(await compileCatalogue(input)).toEqual(release);
});

test('real release validation accepts the proposed closed profile ABI without mutating it', () => {
  const release = releaseWith(compiledProfile(libraryProfile()));
  const before = structuredClone(release);
  expect(validateRelease(release)).toEqual([]);
  expect(release).toEqual(before);
});

const malformed: [string, (p: ProfileData) => void, string][] = [
  [
    'invalid scoped profile id',
    (p) => {
      p.id = 'Unscoped';
    },
    '/id',
  ],
  [
    'invalid revision',
    (p) => {
      p.revision = 0;
    },
    '/revision',
  ],
  [
    'trailing newline identifier',
    (p) => {
      p.id += '\n';
    },
    '/id',
  ],
  [
    'invalid state id',
    (p) => {
      p.entryStateSet.states[0].id = 'bad/id';
    },
    '/entryStateSet/states/0/id',
  ],
  [
    'duplicate state id',
    (p) => {
      p.entryStateSet.states[1].id = 'planned';
    },
    '/entryStateSet/states/1',
  ],
  [
    'empty state set',
    (p) => {
      p.entryStateSet.states = [];
    },
    '/entryStateSet/states',
  ],
  [
    'executable state field',
    (p) => {
      p.entryStateSet.states[0].onEnter = 'complete()';
    },
    '/entryStateSet/states/0/onEnter',
  ],
  [
    'unknown role',
    (p) => {
      p.entryStateSet.states[0].role = 'entitled';
    },
    '/entryStateSet/states/0/role',
  ],
  [
    'fourth algorithm',
    (p) => {
      p.progress[0].mode = 'achievement';
    },
    '/progress/0/mode',
  ],
  [
    'undeclared unit',
    (p) => {
      p.progress[0].units = ['chapter'];
    },
    '/progress/0/units',
  ],
  [
    'unsupported cursor unit',
    (p) => {
      p.progress[0] = { mode: 'cursor_position', units: ['percent'], totalPolicy: 'forbidden' };
    },
    '/progress/0',
  ],
  [
    'sparse identity not established',
    (p) => {
      p.progress[0] = { mode: 'completed_units', units: ['page'], totalPolicy: 'forbidden' };
    },
    '/progress/0',
  ],
  [
    'fabricated achievement identity',
    (p) => {
      p.units[0].id = 'achievement';
    },
    '/units/0/id',
  ],
  [
    'unit executable conversion',
    (p) => {
      p.units[0].convert = 'x * 100';
    },
    '/units/0/convert',
  ],
  [
    'incompatible dimension',
    (p) => {
      p.units[0].dimension = 'duration';
    },
    '/units/0/dimension',
  ],
  [
    'fractional count bound',
    (p) => {
      p.units[0].maximum = 10.5;
    },
    '/units/0/maximum',
  ],
  [
    'fractional page',
    (p) => {
      p.units[0].precision = 1;
    },
    '/units/0/precision',
  ],
  [
    'inverted bounds',
    (p) => {
      p.units[0].minimum = 2;
      p.units[0].maximum = 1;
    },
    '/units/0',
  ],
  [
    'unbounded decimal',
    (p) => {
      p.units[0].maximum = 1e30;
    },
    '/units/0/maximum',
  ],
  [
    'unknown total policy',
    (p) => {
      p.progress[0].totalPolicy = 'auto';
    },
    '/progress/0/totalPolicy',
  ],
  [
    'progress executable field',
    (p) => {
      p.progress[0].algorithm = 'new Function()';
    },
    '/progress/0/algorithm',
  ],
  [
    'cursor total',
    (p) => {
      p.progress[0] = { mode: 'cursor_position', units: ['page'], totalPolicy: 'optional' };
    },
    '/progress/0/totalPolicy',
  ],
  [
    'duplicate progress mode',
    (p) => {
      p.progress.push(structuredClone(p.progress[0]));
    },
    '/progress/1',
  ],
  [
    'duplicate unit',
    (p) => {
      p.units.push(structuredClone(p.units[0]));
    },
    '/units/1',
  ],
  [
    'duplicate copy kind',
    (p) => {
      p.copies.push(structuredClone(p.copies[0]));
    },
    '/copies/2',
  ],
  [
    'empty copy statuses',
    (p) => {
      p.copies[0].statuses = [];
    },
    '/copies/0/statuses',
  ],
  [
    'copy status unknown field',
    (p) => {
      p.copies[0].statuses[0].grant = true;
    },
    '/copies/0/statuses/0/grant',
  ],
  [
    'duplicate copy status',
    (p) => {
      p.copies[0].statuses.push({ id: 'owned' });
    },
    '/copies/0/statuses/2',
  ],
  [
    'arbitrary attributes',
    (p) => {
      p.copies[0].attributes = { whatever: {} };
    },
    '/copies/0/attributes',
  ],
  [
    'entitlement grant',
    (p) => {
      p.copies[1].permissions = ['access'];
    },
    '/copies/1/permissions',
  ],
  [
    'too many states',
    (p) => {
      p.entryStateSet.states = Array.from({ length: 17 }, (_, i) => ({ id: `s${i}` }));
    },
    '/entryStateSet/states',
  ],
  [
    'too many units',
    (p) => {
      p.units = Array.from({ length: 7 }, () => structuredClone(p.units[0]));
    },
    '/units',
  ],
  [
    'too many modes',
    (p) => {
      p.progress = Array.from({ length: 4 }, () => structuredClone(p.progress[0]));
    },
    '/progress',
  ],
  [
    'too many kinds',
    (p) => {
      p.copies = Array.from({ length: 5 }, () => structuredClone(p.copies[0]));
    },
    '/copies',
  ],
  [
    'too many statuses',
    (p) => {
      p.copies[0].statuses = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}` }));
    },
    '/copies/0/statuses',
  ],
  [
    'unknown top field',
    (p) => {
      p.defaultState = 'completed';
    },
    '/defaultState',
  ],
  [
    'prototype field',
    (p) => {
      Object.defineProperty(p, '__proto__', { value: { enabled: true }, enumerable: true });
    },
    '/__proto__',
  ],
];
for (const [name, mutate, pointer] of malformed) {
  test(`compiler rejects library profile: ${name}`, async () => {
    const p = libraryProfile();
    mutate(p);
    const errors = await compilerErrors(fixture(p));
    expect(errors.some((e) => e.pointer.startsWith(`/classes/Parent/annotations/library${pointer}`))).toBe(true);
  });
  test(`release schema and semantics reject library profile: ${name}`, () => {
    const p = compiledProfile(libraryProfile());
    mutate(p);
    expect(validateRelease(releaseWith(p)).some((e) => e.pointer.startsWith(`/types/ex:Child/library${pointer}`))).toBe(
      true,
    );
  });
}

test('library annotation accepts neither scalars nor null and has no implicit suppression', async () => {
  for (const value of [null, false, 'fixture.reading', [], {}]) {
    const input = fixture();
    const schema = JSON.parse(input.schemas['fixture.yaml']!);
    schema.classes.Parent.annotations.library = value;
    input.schemas['fixture.yaml'] = JSON.stringify(schema);
    const errors = await compilerErrors(input);
    expect(
      errors.some((e) => e.code === 'invalid' && e.pointer.startsWith('/classes/Parent/annotations/library')),
    ).toBe(true);
    expect(validateRelease(releaseWith(value)).length).toBeGreaterThan(0);
  }
});

test('copy status pairs and observation kinds survive compilation without granting access', async () => {
  const p = libraryProfile();
  const compiled = profileOf(await compileCatalogue(fixture(p)), 'ex:Child')!;
  expect(compiled.copies.find((k: ProfileData) => k.id === 'physical').statuses.map((s: ProfileData) => s.id)).toEqual([
    'owned',
    'disposed',
  ]);
  expect(compiled.copies.find((k: ProfileData) => k.id === 'digital').statuses.map((s: ProfileData) => s.id)).toEqual([
    'owned',
  ]);
  expect(compiled).not.toHaveProperty('permissions');
  expect(compiled).not.toHaveProperty('enabled');
  const empty = libraryProfile('fixture.no-progress');
  empty.units = [];
  empty.progress = [];
  empty.copies = [];
  expect(profileOf(await compileCatalogue(fixture(empty)), 'ex:Child')).toEqual(compiledProfile(empty));
});

test('percent bounds, precision and fixed total cannot change the scalar algorithm', async () => {
  const p = libraryProfile('fixture.percent', 'percent');
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  for (const mutation of [
    (p: ProfileData) => {
      p.units[0].maximum = 101;
    },
    (p: ProfileData) => {
      p.units[0].minimum = -1;
    },
    (p: ProfileData) => {
      p.units[0].precision = 7;
    },
    (p: ProfileData) => {
      p.progress[0].totalPolicy = 'optional';
    },
  ]) {
    const bad = structuredClone(p);
    mutation(bad);
    expect(validateRelease(releaseWith(compiledProfile(bad))).length).toBeGreaterThan(0);
    expect((await compilerErrors(fixture(bad))).some((e) => e.pointer.includes('/annotations/library/'))).toBe(true);
  }
});

test('cursor mode remains selectable for count positions without totals', async () => {
  const p = libraryProfile();
  p.progress.push({ mode: 'cursor_position', units: ['page'], totalPolicy: 'forbidden' });
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  expect(validateRelease(releaseWith(compiledProfile(p)))).toEqual([]);
});

test('import descriptors are bounded inert mappings and never grant capabilities', async () => {
  const p = libraryProfile();
  p.importSources = [
    {
      id: 'fixture.manual',
      mappingVersion: 'v1',
      types: ['ex:Child', 'ex:Parent', 'ex:Sibling'],
      recordKinds: ['entry_state', 'observation'],
    },
  ];
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  expect(
    validateRelease(
      releaseWith(compiledProfile({ ...p, importSources: [{ ...p.importSources[0], types: ['ex:Child'] }] })),
    ),
  ).toEqual([]);
  for (const key of ['credentials', 'url', 'endpoint', 'permissions', 'mapping', 'enabled']) {
    const bad = structuredClone(p);
    bad.importSources[0][key] = key === 'enabled' ? true : 'https://hostile.example/';
    expect((await compilerErrors(fixture(bad))).some((e) => e.pointer.includes(`/importSources/0/${key}`))).toBe(true);
    expect(
      validateRelease(releaseWith(compiledProfile(bad))).some((e) => e.pointer.includes(`/importSources/0/${key}`)),
    ).toBe(true);
  }
  for (const change of [
    (p: ProfileData) => {
      p.importSources[0].mappingVersion = '';
    },
    (p: ProfileData) => {
      p.importSources[0].types = ['ex:Missing'];
    },
    (p: ProfileData) => {
      p.importSources[0].recordKinds = ['entitlement'];
    },
    (p: ProfileData) => {
      p.importSources.push(structuredClone(p.importSources[0]));
    },
    (p: ProfileData) => {
      p.importSources = Array.from({ length: 9 }, (_, i) => ({ ...p.importSources[0], id: `fixture.s${i}` }));
    },
  ]) {
    const bad = structuredClone(p);
    change(bad);
    expect((await compilerErrors(fixture(bad))).some((e) => e.pointer.includes('/importSources'))).toBe(true);
    expect(validateRelease(releaseWith(compiledProfile(bad))).length).toBeGreaterThan(0);
  }
});

test('ambiguous declarations for one type and duplicate profile identities fail deterministically', async () => {
  const input = fixture();
  const source = JSON.parse(input.schemas['fixture.yaml']!);
  source.classes.Conflicting = { class_uri: 'ex:Child', annotations: { library: libraryProfile('fixture.other') } };
  input.schemas['fixture.yaml'] = JSON.stringify(source);
  const first = await compilerErrors(input);
  expect(first.some((e) => e.code === 'duplicate' || e.code === 'invalid')).toBe(true);
  expect(await compilerErrors(input)).toEqual(first);
  const duplicate = fixture(libraryProfile(), { ...libraryProfile(), revision: 2 });
  expect((await compilerErrors(duplicate)).some((e) => e.pointer.includes('/annotations/library/id'))).toBe(true);
});

test('presentation labels belong to the declaration home and missing or hostile labels fail', async () => {
  const input = fixture();
  const en = JSON.parse(input.presentation['fixture/en']!);
  delete en.libraryProfiles['fixture.reading'].states.planned;
  input.presentation['fixture/en'] = JSON.stringify(en);
  expect((await compilerErrors(input)).some((e) => e.code === 'missing_label' && e.pointer.includes('planned'))).toBe(
    true,
  );
  const wrongHome = fixture();
  wrongHome.presentation['elsewhere/en'] = wrongHome.presentation['fixture/en']!;
  expect(
    (await compilerErrors(wrongHome)).some(
      (e) => e.file === 'presentation/elsewhere/en' && e.pointer.includes('libraryProfiles'),
    ),
  ).toBe(true);
  const bad = compiledProfile(libraryProfile());
  bad.labels.en = 'x'.repeat(81);
  expect(validateRelease(releaseWith(bad)).some((e) => e.pointer.includes('/library/labels/en'))).toBe(true);
  const extra = compiledProfile(libraryProfile());
  extra.labels.it = 'biblioteca';
  expect(validateRelease(releaseWith(extra)).some((e) => e.pointer.includes('/library/labels'))).toBe(true);
});

test('compiled profile bytes are capped independently of the complete release', () => {
  const p = compiledProfile(libraryProfile());
  p.entryStateSet.states = Array.from({ length: 16 }, (_, i) => ({
    id: `s${i}`,
    labels: Object.fromEntries(LIBRARY_LOCALES.map((l) => [l, '界'.repeat(80)])),
  }));
  expect(Buffer.byteLength(JSON.stringify(p))).toBeGreaterThan(16 * 1024);
  expect(
    validateRelease(releaseWith(p)).some((e) => e.code === 'limit' && e.pointer === '/types/ex:Child/library'),
  ).toBe(true);
});

test('library profile revisions preserve old release data and explicit migration meaning', async () => {
  const a = libraryProfile();
  const old = await compileCatalogue(fixture(a));
  const oldBytes = JSON.stringify(old);
  const oldDigest = releaseDigest(old);
  const b = structuredClone(a);
  b.revision = 2;
  b.entryStateSet.states[0].id = 'interested';
  const next = await compileCatalogue(fixture(b));
  expect(validateRelease(old)).toEqual([]);
  expect(validateRelease(next)).toEqual([]);
  expect(releaseDigest(next)).not.toBe(oldDigest);
  expect(profileOf(old, 'ex:Child')!.entryStateSet.states[0].id).toBe('planned');
  expect(profileOf(next, 'ex:Child')!.entryStateSet.states[0].id).toBe('interested');
  const pin = { releaseDigest: oldDigest, type: 'ex:Child', profileId: a.id, profileRevision: 1 };
  const releases = new Map([
    [oldDigest, old],
    [releaseDigest(next), next],
  ]);
  for (const active of [releaseDigest(next), oldDigest]) {
    expect(releases.has(active)).toBe(true);
    const exact = releases.get(pin.releaseDigest)!;
    expect(profileOf(exact, pin.type)).toMatchObject({ id: pin.profileId, revision: pin.profileRevision });
    expect(JSON.stringify(exact)).toBe(oldBytes);
    expect(releaseDigest(exact)).toBe(oldDigest);
  }
  // This is immutable package data, not a claim of library-row replay or migration.
  expect(profileOf(old, 'ex:Child')!.entryStateSet.id).toBe('legacy-five');
});

test('old releases without library stay valid and deterministic with no installed defaults', async () => {
  const input = fixture();
  const source = JSON.parse(input.schemas['fixture.yaml']!);
  for (const cls of Object.values(source.classes) as ProfileData[]) delete cls.annotations;
  input.schemas['fixture.yaml'] = JSON.stringify(source);
  for (const key of Object.keys(input.presentation)) {
    const p = JSON.parse(input.presentation[key]!);
    delete p.libraryProfiles;
    input.presentation[key] = JSON.stringify(p);
  }
  const old = await compileCatalogue(input);
  const digest = releaseDigest(old);
  expect(validateRelease(old)).toEqual([]);
  for (const t of Object.values(old.types)) expect(Object.hasOwn(t, 'library')).toBe(false);
  expect(releaseDigest(old)).toBe(digest);
  expect(await compileCatalogue(input)).toEqual(old);
});

export const launchProfiles = [
  ['book', 'Work', 'schema:Book', 'book.reading', 'page'],
  ['book', 'Edition', 'bf:Instance', 'book.edition', 'page'],
  ['anime', 'TVSeries', 'schema:TVSeries', 'anime.series', 'episode'],
  ['anime', 'TVSeason', 'schema:TVSeason', 'anime.season', 'episode'],
  ['anime', 'Episode', 'schema:Episode', 'anime.episode', 'minute'],
  ['anime', 'Movie', 'schema:Movie', 'anime.film', 'minute'],
  ['game', 'VideoGame', 'schema:VideoGame', 'game.playing', 'minute'],
  ['game', 'VideoGameRelease', 'wd:Q20631656', 'game.release', 'minute'],
  ['game', 'GameAddOn', 'wd:Q209163', 'game.addon', 'minute'],
  ['visual-novel', 'VisualNovel', 'wd:Q689445', 'visual-novel.reading', 'percent'],
  ['recipe', 'Recipe', 'schema:Recipe', 'recipe.cooking', 'minute'],
] as const;

test('book anime game visual novel and recipe library profiles are configuration only', async () => {
  // The package implementation owns adding this exact configuration to these inspected declarations.
  const release = await compileCatalogue(bundledSources());
  for (const [, , type, id, unit] of launchProfiles) {
    const p = profileOf(release, type);
    expect(p).toEqual(compiledProfile(libraryProfile(id, unit)));
    for (const labels of [
      p!.labels,
      p!.entryStateSet.labels,
      ...p!.entryStateSet.states.map((s: ProfileData) => s.labels),
      ...p!.units.map((u: ProfileData) => u.labels),
      ...p!.copies.flatMap((k: ProfileData) => [k.labels, ...k.statuses.map((s: ProfileData) => s.labels)]),
    ]) {
      expect(Object.keys(labels).sort()).toEqual([...LIBRARY_LOCALES]);
    }
  }
  for (const type of ['schema:Person', 'schema:Organization', 'skos:Concept', 'skos:ConceptScheme'])
    expect(profileOf(release, type)).toBeUndefined();
});
