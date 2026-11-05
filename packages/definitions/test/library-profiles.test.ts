import { expect, test } from 'bun:test';
import { bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease } from '../src/index.ts';
import {
  compiledProfile,
  fixture,
  launchProfiles,
  legacyProfile,
  LEGACY_UNITS,
  libraryProfile,
  LIBRARY_LOCALES,
  MODES,
  profileOf,
  referenceOf,
  registryOf,
  releaseWith,
  unitData,
  type ProfileData,
} from './support/library-profiles.ts';

// Executable specification through existing entrypoints; no production implementation in this slice.
async function compilerErrors(input: Parameters<typeof compileCatalogue>[0]) {
  try {
    await compileCatalogue(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Malformed profile compiled');
}
function editSource(input: ReturnType<typeof fixture>, edit: (classes: ProfileData) => void) {
  const schema = JSON.parse(input.schemas['fixture.yaml']);
  edit(schema.classes);
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
}

test('canonical library profile references inherit without runtime unions or duplicate authorities', async () => {
  const parent = libraryProfile();
  const child = libraryProfile('fixture.child', 'percent');
  child.entryStateSet = { id: 'choice', states: [{ id: 'interested' }] };
  child.copies = { kinds: [] };
  const input = fixture(parent, child);
  // Repeated identical authored declarations deduplicate, including their labels.
  editSource(input, (classes) => {
    classes.Sibling.annotations = { library: parent };
  });
  const before = structuredClone(input);
  const release = await compileCatalogue(input);
  expect(validateRelease(release)).toEqual([]);
  expect(referenceOf(release, 'ex:Child')).toEqual({ profileId: child.id });
  for (const type of ['ex:Parent', 'ex:Sibling']) {
    expect(referenceOf(release, type)).toEqual({ profileId: parent.id });
    expect(profileOf(release, type)).toEqual(compiledProfile(parent));
  }
  expect(profileOf(release, 'ex:Child')).toEqual(compiledProfile(child));
  expect(profileOf(release, 'ex:Child')!.entryStateSet.states).toHaveLength(1);
  expect(profileOf(release, 'ex:Child')!.copies.kinds).toEqual([]);
  expect(referenceOf(release, 'ex:Person')).toBeUndefined();
  expect(Object.keys(registryOf(release)!).sort()).toEqual(
    ['fixture.root', parent.id, child.id, 'legacy-fixed-v1'].sort(),
  );
  expect(input).toEqual(before);
  const inherited = await compileCatalogue(fixture(parent));
  expect(referenceOf(inherited, 'ex:Child')).toEqual({ profileId: parent.id });
  expect(Object.keys(referenceOf(inherited, 'ex:Child')!)).toEqual(['profileId']);
  expect(registryOf(inherited)![parent.id]).toEqual(compiledProfile(parent));
  // Only one immutable registry object is authoritative for all these references.
  expect(profileOf(inherited, 'ex:Parent')).toBe(profileOf(inherited, 'ex:Child'));
});

test('same profile ID with different bodies or labels is rejected, identical bodies deduplicate', async () => {
  const input = fixture();
  editSource(input, (classes) => {
    const other = libraryProfile();
    other.progress.allowed[0].units[0].maximum = '17';
    classes.Sibling.annotations = { library: other };
  });
  expect((await compilerErrors(input)).some((e) => e.pointer.includes('/annotations/library'))).toBe(true);
  const release = releaseWith();
  registryOf(release)!['fixture.reading']!.id = 'different.id';
  expect(validateRelease(release).some((e) => e.pointer.startsWith('/libraryProfiles/fixture.reading'))).toBe(true);
});

test('explicit legacy profile data preserves all accepted mode/unit pairs without enabling unrelated types', async () => {
  const release = await compileCatalogue(fixture());
  const p = registryOf(release)!['legacy-fixed-v1']!;
  expect(p).toEqual(compiledProfile(legacyProfile()));
  expect(p.entryStateSet.states.map((s: ProfileData) => s.id)).toEqual([
    'planned',
    'in_progress',
    'completed',
    'paused',
    'dropped',
  ]);
  expect(p.progress.allowed.map((m: ProfileData) => m.mode)).toEqual([...MODES]);
  expect(p.progress.allowed.flatMap((m: ProfileData) => m.units.map((u: ProfileData) => `${m.mode}/${u.id}`))).toEqual(
    MODES.flatMap((mode) => LEGACY_UNITS.map((unit) => `${mode}/${unit}`)),
  );
  for (const m of p.progress.allowed)
    for (const u of m.units) {
      expect(u).not.toHaveProperty('precision');
      expect(u.identity).toEqual({ kind: m.mode === 'completed_units' ? 'session_local' : 'none' });
      expect(u.structure).toEqual({ kind: 'none' });
      expect(u.totalPolicy).toBe(m.mode === 'scalar_amount' ? 'optional' : 'forbidden');
      expect(u.minimum).toBe('0');
      if (m.mode === 'scalar_amount' && u.id === 'percent') expect(u.maximum).toBe('100');
      else expect(u).not.toHaveProperty('maximum');
    }
  expect(p.copies.kinds).toEqual(compiledProfile(legacyProfile()).copies.kinds);
  expect(p.copies.kinds[0].id).toBe('legacy-unspecified');
  expect(p.copies.kinds[0].statuses.map((s: ProfileData) => s.id)).toEqual(['ordered', 'owned', 'lent', 'disposed']);
  expect(Object.keys(release.types).sort()).toEqual(['ex:Child', 'ex:Parent', 'ex:Person', 'ex:Sibling']);
  for (const t of Object.keys(release.types)) expect(referenceOf(release, t)?.profileId).not.toBe(p.id);
  expect(referenceOf(release, 'ex:Person')).toBeUndefined();
});

test('release-pinned profile bases distinguish unknown historical accepting type from current type', async () => {
  const a = await compileCatalogue(fixture());
  const bytes = JSON.stringify(a);
  const digest = releaseDigest(a);
  const changed = libraryProfile();
  changed.entryStateSet.states[0].id = 'interested';
  const b = await compileCatalogue(fixture(changed));
  expect(validateRelease(a)).toEqual([]);
  expect(validateRelease(b)).toEqual([]);
  expect(releaseDigest(b)).not.toBe(digest);
  const releases = new Map([
    [digest, a],
    [releaseDigest(b), b],
  ]);
  const normal = {
    provenance: 'profile',
    releaseDigest: digest,
    acceptingType: 'ex:Child',
    profileId: 'fixture.reading',
  } as const;
  const unknownLegacy = {
    provenance: 'legacy',
    releaseDigest: digest,
    acceptingType: null,
    profileId: 'legacy-fixed-v1',
  } as const;
  const retainedLegacy = { ...unknownLegacy, acceptingType: 'ex:Person' };
  // Only immutable lookup is demonstrated. No simulated transaction, migration, activation or replay API.
  for (const availableDigest of [releaseDigest(b), digest]) {
    expect(releases.has(availableDigest)).toBe(true);
    const exact = releases.get(normal.releaseDigest)!;
    expect(referenceOf(exact, normal.acceptingType)).toEqual({ profileId: normal.profileId });
    expect(registryOf(exact)![normal.profileId]).toEqual(compiledProfile(libraryProfile()));
    for (const pin of [unknownLegacy, retainedLegacy]) {
      expect(registryOf(releases.get(pin.releaseDigest)!)![pin.profileId]).toEqual(compiledProfile(legacyProfile()));
      expect(pin).not.toHaveProperty('profileRevision');
    }
    expect(unknownLegacy.acceptingType).toBeNull();
    expect(referenceOf(b, 'ex:Person')).toBeUndefined();
    expect(JSON.stringify(exact)).toBe(bytes);
    expect(releaseDigest(exact)).toBe(digest);
  }
  expect(profileOf(b, 'ex:Child')!.entryStateSet.states[0].id).toBe('interested');
});

test('old releases without library stay valid and deterministic with no installed defaults', async () => {
  const input = fixture();
  editSource(input, (classes) => {
    for (const cls of Object.values(classes) as ProfileData[]) delete cls.annotations;
  });
  for (const key of Object.keys(input.presentation)) {
    const p = JSON.parse(input.presentation[key]!);
    delete p.libraryProfiles;
    input.presentation[key] = JSON.stringify(p);
  }
  const old = await compileCatalogue(input);
  expect(validateRelease(old)).toEqual([]);
  expect(registryOf(old)).toBeUndefined();
  for (const t of Object.values(old.types)) expect(t).not.toHaveProperty('library');
  const digest = releaseDigest(old);
  expect(await compileCatalogue(input)).toEqual(old);
  expect(releaseDigest(old)).toBe(digest);
});

test('optional capabilities replace whole declarations and empty lists never inherit fields', async () => {
  for (const child of [
    { id: 'fixture.empty' },
    { id: 'fixture.empty', progress: { allowed: [] }, copies: { kinds: [] }, importSources: [] },
  ]) {
    const release = await compileCatalogue(fixture(libraryProfile(), child));
    expect(profileOf(release, 'ex:Child')).toEqual(child);
    expect(profileOf(release, 'ex:Child')).not.toHaveProperty('entryStateSet');
    expect(validateRelease(release)).toEqual([]);
  }
});

test('per-pair metadata supports arbitrary units, fractional counts, cursor percent and sparse keys', async () => {
  const p = libraryProfile('fixture.gardening', 'seed-tray.v2');
  p.progress.allowed = MODES.map((mode) => ({
    mode,
    units: [unitData('page', mode), unitData('percent', mode), unitData('seed-tray.v2', mode)],
  }));
  const scalar = p.progress.allowed[0].units[0];
  Object.assign(scalar, {
    dimension: 'count',
    precision: 6,
    minimum: '0.000001',
    maximum: '999999999999.999999',
    totalPolicy: 'required',
  });
  // No global meaning is inferred from a unit name; a different pair can use different inert metadata.
  Object.assign(p.progress.allowed[1].units[0], { dimension: 'duration', precision: 1, maximum: '100.5' });
  const compiled = await compileCatalogue(fixture(p));
  expect(profileOf(compiled, 'ex:Child')).toEqual(compiledProfile(p));
  expect(validateRelease(compiled)).toEqual([]);
  expect(p.progress.allowed[1].units[1]).not.toHaveProperty('maximum');
  expect(p.progress.allowed[2].units[1].identity).toEqual({ kind: 'session_local' });
});

// Every row is checked through both source compilation and closed release validation.
const malformed: [string, (p: ProfileData) => void, string][] = [
  [
    'profile newline',
    (p) => {
      p.id += '\n';
    },
    '/id',
  ],
  [
    'profile length',
    (p) => {
      p.id = 'x'.repeat(65);
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
    'empty state set',
    (p) => {
      p.entryStateSet.states = [];
    },
    '/entryStateSet/states',
  ],
  [
    'duplicate state',
    (p) => {
      p.entryStateSet.states[1].id = 'planned';
    },
    '/entryStateSet/states/1',
  ],
  [
    'unknown role',
    (p) => {
      p.entryStateSet.states[0].role = 'entitled';
    },
    '/entryStateSet/states/0/role',
  ],
  [
    'numeric source bound',
    (p) => {
      p.progress.allowed[0].units[0].minimum = 0;
    },
    '/progress/allowed/0/units/0/minimum',
  ],
  [
    'numeric upper bound',
    (p) => {
      p.progress.allowed[0].units[0].maximum = 100;
    },
    '/progress/allowed/0/units/0/maximum',
  ],
  [
    'inverted exact decimals',
    (p) => {
      Object.assign(p.progress.allowed[0].units[0], { minimum: '999999999999.000002', maximum: '999999999999.000001' });
    },
    '/progress/allowed/0/units/0',
  ],
  [
    'precision seven',
    (p) => {
      p.progress.allowed[0].units[0].precision = 7;
    },
    '/progress/allowed/0/units/0/precision',
  ],
  [
    'precision fractional',
    (p) => {
      p.progress.allowed[0].units[0].precision = 0.5;
    },
    '/progress/allowed/0/units/0/precision',
  ],
  [
    'unknown total',
    (p) => {
      p.progress.allowed[0].units[0].totalPolicy = 'fixed_100';
    },
    '/progress/allowed/0/units/0/totalPolicy',
  ],
  [
    'fourth mode',
    (p) => {
      p.progress.allowed[0].mode = 'achievement';
    },
    '/progress/allowed/0/mode',
  ],
  [
    'duplicate mode',
    (p) => {
      p.progress.allowed.push(structuredClone(p.progress.allowed[0]));
    },
    '/progress/allowed/1',
  ],
  [
    'duplicate unit within pair',
    (p) => {
      p.progress.allowed[0].units.push(structuredClone(p.progress.allowed[0].units[0]));
    },
    '/progress/allowed/0/units/1',
  ],
  [
    'provider identity',
    (p) => {
      p.progress.allowed[0].units[0].identity = { kind: 'catalogue', provider: 'episodes' };
    },
    '/progress/allowed/0/units/0/identity',
  ],
  [
    'provider structure',
    (p) => {
      p.progress.allowed[0].units[0].structure = { kind: 'edition', revision: '1' };
    },
    '/progress/allowed/0/units/0/structure',
  ],
  [
    'scalar local identity',
    (p) => {
      p.progress.allowed[0].units[0].identity.kind = 'session_local';
    },
    '/progress/allowed/0/units/0/identity',
  ],
  [
    'sparse no identity',
    (p) => {
      p.progress.allowed = [{ mode: 'completed_units', units: [unitData('page')] }];
    },
    '/progress/allowed/0/units/0/identity',
  ],
  [
    'duplicate kind',
    (p) => {
      p.copies.kinds.push(structuredClone(p.copies.kinds[0]));
    },
    '/copies/kinds/2',
  ],
  [
    'empty statuses',
    (p) => {
      p.copies.kinds[0].statuses = [];
    },
    '/copies/kinds/0/statuses',
  ],
  [
    'duplicate status',
    (p) => {
      p.copies.kinds[0].statuses.push({ id: 'owned' });
    },
    '/copies/kinds/0/statuses/2',
  ],
  [
    'too many states',
    (p) => {
      p.entryStateSet.states = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}` }));
    },
    '/entryStateSet/states',
  ],
  [
    'too many units',
    (p) => {
      p.progress.allowed[0].units = Array.from({ length: 33 }, (_, i) => unitData(`u${i}`));
    },
    '/progress/allowed/0/units',
  ],
  [
    'too many modes',
    (p) => {
      p.progress.allowed = Array.from({ length: 4 }, () => structuredClone(p.progress.allowed[0]));
    },
    '/progress/allowed',
  ],
  [
    'too many kinds',
    (p) => {
      p.copies.kinds = Array.from({ length: 17 }, (_, i) => ({ id: `k${i}`, statuses: [{ id: 'owned' }] }));
    },
    '/copies/kinds',
  ],
  [
    'too many statuses',
    (p) => {
      p.copies.kinds[0].statuses = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}` }));
    },
    '/copies/kinds/0/statuses',
  ],
  [
    'too many sources',
    (p) => {
      p.importSources = Array.from({ length: 33 }, (_, i) => ({
        id: `s${i}`,
        mappingVersion: 'v1',
        recordKinds: ['observation'],
      }));
    },
    '/importSources',
  ],
  [
    'too many record kinds',
    (p) => {
      p.importSources = [
        { id: 'manual', mappingVersion: 'v1', recordKinds: Array.from({ length: 17 }, (_, i) => `r${i}`) },
      ];
    },
    '/importSources/0/recordKinds',
  ],
];
for (const bound of ['-1', '01', '1e3', '1.', '.1', '1000000000000', '0.0000001', '1\n']) {
  malformed.push([
    `decimal ${JSON.stringify(bound)}`,
    (p) => {
      p.progress.allowed[0].units[0].maximum = bound;
    },
    '/progress/allowed/0/units/0/maximum',
  ]);
}
for (const mode of ['cursor_position', 'completed_units']) {
  malformed.push([
    `${mode} total`,
    (p) => {
      p.progress.allowed = [{ mode, units: [{ ...unitData('page', mode), totalPolicy: 'optional' }] }];
    },
    '/progress/allowed/0/units/0/totalPolicy',
  ]);
}
const paths = [
  '',
  '/entryStateSet',
  '/entryStateSet/states/0',
  '/progress',
  '/progress/allowed/0',
  '/progress/allowed/0/units/0',
  '/progress/allowed/0/units/0/identity',
  '/progress/allowed/0/units/0/structure',
  '/copies',
  '/copies/kinds/0',
  '/copies/kinds/0/statuses/0',
  '/importSources/0',
];
for (const path of paths) {
  malformed.push([
    `closed object ${path || '/'}`,
    (p) => {
      p.importSources = [{ id: 'fixture.manual', mappingVersion: 'v1', recordKinds: ['observation'] }];
      let node = p;
      for (const key of path.split('/').filter(Boolean)) node = node[key];
      node.executable = 'run()';
    },
    `${path}/executable`,
  ]);
}
for (const key of [
  'revision',
  'labels',
  'units',
  'credentials',
  'endpoint',
  'enabled',
  'adapter',
  'defaultState',
  '__proto__',
]) {
  malformed.push([
    `obsolete or hostile root ${key}`,
    (p) => {
      Object.defineProperty(p, key, { value: 'forbidden', enumerable: true });
    },
    `/${key}`,
  ]);
}
for (const [name, mutate, pointer] of malformed) {
  test(`compiler rejects library profile: ${name}`, async () => {
    const p = libraryProfile();
    mutate(p);
    expect(
      (await compilerErrors(fixture(p))).some((e) =>
        e.pointer.startsWith(`/classes/Parent/annotations/library${pointer}`),
      ),
    ).toBe(true);
  });
  test(`release schema and semantics reject library profile: ${name}`, () => {
    const p = compiledProfile(libraryProfile());
    mutate(p);
    expect(
      validateRelease(releaseWith(p)).some((e) => e.pointer.startsWith(`/libraryProfiles/fixture.reading${pointer}`)),
    ).toBe(true);
  });
}

test('references are closed, present, nonlegacy and registry keys match canonical IDs', () => {
  expect(validateRelease(releaseWith())).toEqual([]);
  for (const reference of [
    null,
    false,
    [],
    {},
    'fixture.reading',
    { profileId: 'missing' },
    { profileId: 'fixture.reading', revision: 1 },
    { profileId: 'fixture.reading', ...compiledProfile(libraryProfile()) },
  ]) {
    const release = releaseWith();
    (release.types['ex:Child'] as unknown as ProfileData).library = reference;
    expect(validateRelease(release).some((e) => e.pointer.startsWith('/types/ex:Child/library'))).toBe(true);
  }
  const legacy = releaseWith();
  registryOf(legacy)!['legacy-fixed-v1'] = compiledProfile(legacyProfile());
  (legacy.types['ex:Child'] as unknown as ProfileData).library = { profileId: 'legacy-fixed-v1' };
  expect(validateRelease(legacy).some((e) => e.pointer.startsWith('/types/ex:Child/library'))).toBe(true);
});

test('annotations accept mappings only; legacy declaration stays unattached and inert', async () => {
  for (const value of [null, false, 'fixture.reading', [], {}]) {
    expect(
      (await compilerErrors(fixture(value))).some((e) => e.pointer.startsWith('/classes/Parent/annotations/library')),
    ).toBe(true);
  }
  const attached = fixture(legacyProfile());
  expect((await compilerErrors(attached)).some((e) => e.pointer.includes('/annotations/library'))).toBe(true);
});

test('import mappings are inert closed declarations with duplicate and reference validation', async () => {
  const p = libraryProfile();
  p.importSources = [
    {
      id: 'fixture.manual',
      mappingVersion: 'v1.0',
      recordKinds: ['entry_state', 'progress', 'holding', 'observation'],
    },
  ];
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  for (const mutate of [
    (p: ProfileData) => {
      p.importSources.push(structuredClone(p.importSources[0]));
    },
    (p: ProfileData) => {
      p.importSources[0].recordKinds.push('observation');
    },
    (p: ProfileData) => {
      p.importSources[0].recordKinds = ['bad/kind'];
    },
    (p: ProfileData) => {
      p.importSources[0].types = ['ex:Missing'];
    },
    (p: ProfileData) => {
      p.importSources[0].credentials = 'secret';
    },
  ]) {
    const invalid = structuredClone(p);
    mutate(invalid);
    expect((await compilerErrors(fixture(invalid))).some((e) => e.pointer.includes('/importSources'))).toBe(true);
    expect(
      validateRelease(releaseWith(compiledProfile(invalid))).some((e) => e.pointer.includes('/importSources')),
    ).toBe(true);
  }
});

test('presentation homes are closed, mode-specific, English-required and bounded', async () => {
  const p = legacyProfile();
  const input = fixture();
  const home = JSON.parse(input.presentation['fixture/en']!);
  home.libraryProfiles[p.id].units.scalar_amount.percent = 'amount percent';
  home.libraryProfiles[p.id].units.cursor_position.percent = 'position percent';
  input.presentation['fixture/en'] = JSON.stringify(home);
  const release = await compileCatalogue(input);
  const modes = registryOf(release)![p.id]!.progress.allowed;
  expect(modes[0].units.find((u: ProfileData) => u.id === 'percent').labels.en).toBe('amount percent');
  expect(modes[1].units.find((u: ProfileData) => u.id === 'percent').labels.en).toBe('position percent');
  for (const mutate of [
    (h: ProfileData) => {
      delete h.libraryProfiles['fixture.reading'].states.planned;
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].states.planned = '';
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].states.planned = '界'.repeat(81);
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].units.page = 'misplaced';
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].states.unknown = 'unknown';
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].profile = 'invented';
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].stateSet = 'invented';
    },
    (h: ProfileData) => {
      h.libraryProfiles['fixture.reading'].importSources = {};
    },
  ]) {
    const bad = fixture();
    const labels = JSON.parse(bad.presentation['fixture/en']!);
    mutate(labels);
    bad.presentation['fixture/en'] = JSON.stringify(labels);
    expect(
      (await compilerErrors(bad)).some(
        (e) => e.file.startsWith('presentation/') && e.pointer.includes('libraryProfiles'),
      ),
    ).toBe(true);
  }
  const misplaced = fixture();
  misplaced.presentation['elsewhere/en'] = misplaced.presentation['fixture/en']!;
  expect(
    (await compilerErrors(misplaced)).some(
      (e) => e.file === 'presentation/elsewhere/en' && e.pointer.includes('libraryProfiles'),
    ),
  ).toBe(true);
  for (const labels of [{ en: '' }, { en: '界'.repeat(81) }, { en: 'state', it: 'stato' }, { de: 'Zustand' }]) {
    const bad = compiledProfile(libraryProfile());
    bad.entryStateSet.states[0].labels = labels;
    expect(validateRelease(releaseWith(bad)).some((e) => e.pointer.includes('/states/0/labels'))).toBe(true);
  }
});

test('book anime game visual novel and recipe library profiles are configuration only', async () => {
  const release = await compileCatalogue(bundledSources());
  for (const [, , type, id, unit] of launchProfiles) {
    expect(referenceOf(release, type)).toEqual({ profileId: id });
    const p = profileOf(release, type)!;
    expect(p).toEqual(compiledProfile(libraryProfile(id, unit)));
    for (const labels of [
      ...p.entryStateSet.states.map((s: ProfileData) => s.labels),
      ...p.progress.allowed.flatMap((m: ProfileData) => m.units.map((u: ProfileData) => u.labels)),
      ...p.copies.kinds.flatMap((k: ProfileData) => [k.labels, ...k.statuses.map((s: ProfileData) => s.labels)]),
    ])
      expect(Object.keys(labels).sort()).toEqual([...LIBRARY_LOCALES]);
  }
  expect(registryOf(release)!['legacy-fixed-v1']).toEqual(compiledProfile(legacyProfile()));
  for (const type of ['schema:Person', 'schema:Organization', 'skos:Concept', 'skos:ConceptScheme'])
    expect(referenceOf(release, type)).toBeUndefined();
});

test('agreed cardinality maxima and eight-locale labels fit actual canonical release bytes', async () => {
  const p = libraryProfile();
  p.entryStateSet.states = Array.from({ length: 64 }, (_, i) => ({ id: `s${i}` }));
  p.progress.allowed = MODES.map((mode) => ({
    mode,
    units: Array.from({ length: 32 }, (_, i) => unitData(`u${i}`, mode)),
  }));
  p.copies.kinds = Array.from({ length: 16 }, (_, i) => ({
    id: `k${i}`,
    statuses: Array.from({ length: 64 }, (_, j) => ({ id: `s${j}` })),
  }));
  p.importSources = Array.from({ length: 32 }, (_, i) => ({
    id: `s${i}`,
    mappingVersion: 'v1',
    recordKinds: Array.from({ length: 16 }, (_, j) => `r${j}`),
  }));
  const input = fixture(p);
  const long = '界'.repeat(80);
  for (const key of Object.keys(input.presentation)) {
    const home = JSON.parse(input.presentation[key]!);
    const fill = (node: ProfileData) => {
      for (const key of Object.keys(node)) {
        if (typeof node[key] === 'string') node[key] = long;
        else fill(node[key]);
      }
    };
    fill(home.libraryProfiles[p.id]);
    input.presentation[key] = JSON.stringify(home);
  }
  const release = await compileCatalogue(input);
  expect(validateRelease(release)).toEqual([]);
  const canonicalize = (await import('canonicalize')).default;
  const { RELEASE_LIMITS } = await import('../src/index.ts');
  expect(Buffer.byteLength(canonicalize(release)!)).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
  const max = registryOf(release)![p.id]!;
  expect(max.entryStateSet.states).toHaveLength(64);
  expect(max.progress.allowed.map((m: ProfileData) => m.units.length)).toEqual([32, 32, 32]);
  expect(max.copies.kinds).toHaveLength(16);
  expect(max.copies.kinds.every((k: ProfileData) => k.statuses.length === 64)).toBe(true);
  expect(max.importSources).toHaveLength(32);
  expect(max.importSources.every((s: ProfileData) => s.recordKinds.length === 16)).toBe(true);
  expect(max.entryStateSet.states[0].labels.en).toBe(long);
});

test('repeated declarations in distinct presentation groups deduplicate only identical labelled objects', async () => {
  const input = fixture();
  const schema = JSON.parse(input.schemas['fixture.yaml']);
  schema.imports.push('extra');
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  (input.schemas as Record<string, string>)['extra.yaml'] = JSON.stringify({
    id: 'https://example.org/extra',
    name: 'extra',
    version: '1',
    imports: ['linkml:types'],
    prefixes: { linkml: 'https://w3id.org/linkml/' },
    classes: { DuplicateData: { abstract: true, annotations: { library: libraryProfile() } } },
  });
  for (const locale of LIBRARY_LOCALES) {
    const home = JSON.parse(input.presentation[`fixture/${locale}`]!);
    input.presentation[`extra/${locale}`] = JSON.stringify({
      libraryProfiles: { 'fixture.reading': home.libraryProfiles['fixture.reading'] },
    });
  }
  const release = await compileCatalogue(input);
  expect(validateRelease(release)).toEqual([]);
  expect(Object.keys(registryOf(release)!).sort()).toEqual(['fixture.reading', 'fixture.root', 'legacy-fixed-v1']);
  const labels = JSON.parse(input.presentation['extra/en']!);
  labels.libraryProfiles['fixture.reading'].states.planned = 'Different label';
  input.presentation['extra/en'] = JSON.stringify(labels);
  expect(
    (await compilerErrors(input)).some(
      (e) => e.pointer.includes('libraryProfiles') || e.pointer.includes('/annotations/library'),
    ),
  ).toBe(true);
});

test('identifier boundaries and absent precision or total policy remain data rather than unit-name rules', async () => {
  const p = libraryProfile('a'.repeat(64), 'seed-tray.v2');
  const unit = p.progress.allowed[0].units[0];
  delete unit.totalPolicy;
  Object.assign(unit, { dimension: 'count', precision: 0, minimum: '0', maximum: '999999999999' });
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  delete unit.precision;
  Object.assign(unit, { minimum: '1.000001', maximum: '1.000001' });
  expect(profileOf(await compileCatalogue(fixture(p)), 'ex:Child')).toEqual(compiledProfile(p));
  expect(validateRelease(releaseWith())).toEqual([]);
});

test('source labels cannot duplicate presentation authority at any named leaf', async () => {
  for (const path of [
    '/entryStateSet/states/0',
    '/progress/allowed/0/units/0',
    '/copies/kinds/0',
    '/copies/kinds/0/statuses/0',
  ]) {
    const p = libraryProfile();
    let node = p;
    for (const key of path.split('/').filter(Boolean)) node = node[key];
    node.labels = { en: 'Inline label' };
    expect(
      (await compilerErrors(fixture(p))).some((e) =>
        e.pointer.startsWith(`/classes/Parent/annotations/library${path}/labels`),
      ),
    ).toBe(true);
  }
});

test('legacy abstract source is forbidden from gaining a class URI or descendants', async () => {
  for (const edit of [
    (classes: ProfileData) => {
      classes.LegacyData.class_uri = 'ex:Legacy';
    },
    (classes: ProfileData) => {
      classes.LegacyChild = { abstract: true, is_a: 'LegacyData' };
    },
    (classes: ProfileData) => {
      classes.LegacyData.abstract = false;
    },
  ]) {
    const input = fixture();
    editSource(input, edit);
    expect((await compilerErrors(input)).some((e) => e.pointer.includes('/classes/Legacy'))).toBe(true);
  }
});
