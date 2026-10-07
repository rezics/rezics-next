import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { establishedDeclarations } from '../compiler/registry.ts';
import { parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import * as globalContext from '../definitions/global-rating-standing-context-v1.ts';
import * as globalObservation from '../definitions/global-rating-standing-observation-v1.ts';
import * as targetContextDeclaration from '../definitions/realm-target-rating-context-v1.ts';
import * as targetObservationDeclaration from '../definitions/realm-target-rating-observation-v1.ts';
import * as releaseContextDeclaration from '../definitions/realm-release-rating-context-v1.ts';
import * as releaseObservationDeclaration from '../definitions/realm-release-rating-observation-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const authorComment = '\n# Authored SHACL constraints for rating evidence.\n';
const ids = [
  'global-rating-standing-context-v1',
  'global-rating-standing-observation-v1',
  'realm-daily-rating-context-v1',
  'realm-daily-rating-observation-v1',
  'realm-standing-rating-context-v1',
  'realm-standing-rating-observation-v1',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const modules = [
  ['global-rating-standing-context-v1.ts', globalContext],
  ['global-rating-standing-observation-v1.ts', globalObservation],
] as const;
const options = {
  established: Object.fromEntries(
    Object.entries(establishedDeclarations).filter(([id]) => ids.includes(id)),
  ),
  canonicalOrder: [],
  demandOrder: [],
};
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/rating-turtle-'));
  temporary.push(path);
  return path;
}
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
function normalizedProperties(properties: readonly PropertyDefinition[]) {
  return properties
    .map((property) =>
      Object.fromEntries(
        Object.entries(property)
          .filter(([key]) => !['hasValueBeforeMaxCount', 'lineBreaks', 'wrapAfter'].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .sort(
      (a, b) =>
        String(a.path).localeCompare(String(b.path)) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
}
function constraints(profile: ProfileDefinition): string {
  return JSON.stringify(
    profile.shapes.map((shape) => ({
      iri: shape.iri,
      properties: normalizedProperties(shape.properties),
      ...(shape.or ? { or: shape.or.map(normalizedProperties) } : {}),
      ...(shape.closed ? { closed: shape.closed } : {}),
    })),
  );
}

// The accepted definition's bytes and constraints before conversion to authored Turtle.
const original = {
  'global-rating-standing-context-v1': [
    '305e68af3c289f9cd3560a814bc34f9ab7d79b7733a2682f08c944073664191b',
    '06c5335f02b900b236ffdd2622a0ba872fe5a4c875858d38c761d89ac754615b',
  ],
  'global-rating-standing-observation-v1': [
    '88ebf1f8b846fdbb5fbd44835c7f547280d6a4533e68a665d6804e7d77e193b9',
    '0b7c05c1eb579b9d1cf4e321d5c4560322a150d02e0b2b4dcf3370f29ee40be1',
  ],
  'realm-daily-rating-context-v1': [
    'a1819809844d44a1766a4dd20713e8c639eed5b71d158c4458f861de0842e149',
    'b1cfb55cc03db506476c3311850755c1e53455c78b72a2b3ecd6d74bfe260567',
  ],
  'realm-daily-rating-observation-v1': [
    '6f5ddc3f11cc7a0c31a859e7352d65ef7c9983161ae8d5ffde93eaa922a8e658',
    'ef5b267a710aa44e2066549805645a812c897c006b86aa595973c7c1e5586859',
  ],
  'realm-standing-rating-context-v1': [
    'be1cfde2f3f0c6207e684829b7a5a9c66383f52a640908051cd245ebf0454cd9',
    '4ae2959dd1bfe22cc7663ec4bcc293f064536001185f7e70d5feb9bce77435c4',
  ],
  'realm-standing-rating-observation-v1': [
    'a0206416dfc9d591e187dc22400ac802810a01245adb20e4ff48bdd4360960da',
    'e509efe25ede69cbd8c9bf9ebf91df84f58c49763b60a507f670f6706647dfd4',
  ],
} as const;
const derived = {
  'realm-target-rating-context-v1':
    '458855f6cc7d4aa179bf509e08052952e145386f7c49e0156eb093865755bbad',
  'realm-target-rating-observation-v1':
    '68190c45ada5afc7f25772bacdff30c274601e1b750c2fb6a57d04214132ea5b',
  'realm-release-rating-context-v1':
    '66e41c13479d15267a9eee21c8103e748af095d3f1a51591dd759ce6384139c0',
  'realm-release-rating-observation-v1':
    '39e8e35c454994b4fdeae65aecfa46dac579c9dff1a1d029f58405244c390ce9',
  'realm-experience-rating-context-v1':
    '0e5af76067929532ef59e6afaf033b7fc5dc31d861d993663d1a26e602df8f75',
  'realm-experience-rating-observation-v1':
    'b9cbd15b0e4a570c09f27e7c100269ce2978d82883f65205c7077acd35b708be',
};
const roles = (id: string) =>
  id.endsWith('context-v1')
    ? id.startsWith('global-')
      ? ['context']
      : ['realm', 'context']
    : id.startsWith('global-')
      ? ['context', 'work', 'main', 'observation', 'revision']
      : ['realm', 'context', 'work', 'main', 'observation', 'revision'];
const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, node: Record<string, unknown>): Promise<boolean> {
  return Value.Check((await schemas())[`${definition}${id}/${role}-shape`]!, node);
}
function context(id: string): Record<string, unknown> {
  const global = id.startsWith('global-');
  const daily = id.includes('-daily-');
  return {
    '@id': 'urn:rating:context',
    'rdf:type': global
      ? [`${rv}GlobalRatingContext`]
      : [`${rv}RatingContext`, ...(daily ? [`${rv}DailyRatingContext`] : [])],
    'rv:contextState': [`${rv}Active`],
    'rv:targetGrain': [`${rv}MainVersion`],
    'rv:ratingScaleMin': [1],
    'rv:ratingScaleMax': [global ? 5 : 10],
    'rv:ratingCadence': [`${definition}rating-${daily ? 'daily' : 'standing'}-v1`],
    'rv:ratingPopulationPolicy': [
      `${definition}rating-${global ? 'global-' : ''}account-principal-population-v1`,
    ],
    'rv:ratingAggregationPolicy': [`${definition}rating-latest-per-rater-mean-v1`],
    ...(global
      ? {
          'rv:ratingPopulationOwner': [
            'https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c',
          ],
        }
      : { 'rv:realm': ['urn:rating:realm'] }),
    ...(daily
      ? {
          'rv:ratingTimeZone': ['Asia/Shanghai'],
          'rv:ratingCalendar': [`${definition}rating-iso-calendar-v1`],
        }
      : {}),
    ...(id.endsWith('context-v1')
      ? {
          'rv:question': [{ '@value': 'How was it?', '@language': 'en' }],
          ...(global ? { 'rv:head': ['urn:rating:head'] } : {}),
        }
      : {}),
  };
}
const timestamp = '2026-10-07T00:00:00Z';
function revision(id: string): Record<string, unknown> {
  const global = id.startsWith('global-');
  const daily = id.includes('-daily-');
  return {
    '@id': 'urn:rating:revision',
    'rdf:type': global
      ? [`${rv}GlobalRatingObservationRevision`]
      : [
          `${rv}RatingObservationRevision`,
          ...(daily ? [`${rv}DailyRatingObservationRevision`] : []),
        ],
    'rv:observation': ['urn:rating:observation'],
    'rv:ratingAvailability': [`${rv}Available`],
    'rv:ratingValue': [global ? 5 : 10],
    'rv:evaluatedAt': [timestamp],
    'rv:submittedAt': [timestamp],
    'rv:originalSubmissionAt': [timestamp],
    'rv:revisedAt': [timestamp],
    ...(daily
      ? {
          'rv:ratingDay': ['2026-10-07'],
          'rv:ratingTimeZone': ['Asia/Shanghai'],
          'rv:ratingCalendar': [`${definition}rating-iso-calendar-v1`],
          'rv:periodStart': [timestamp],
          'rv:periodEnd': ['2026-10-08T00:00:00Z'],
        }
      : {}),
  };
}

test('six discovered rating Turtle profiles preserve all constraints, focus roles and command declarations', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  const published = commandProfiles(discovered, options);
  const admitted = commandProfiles(profiles, options);
  expect(published.manifest).toEqual(admitted.manifest);
  for (const profile of discovered) {
    expect(digest(constraints(profile))).toBe(original[profile.id as keyof typeof original][1]);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      roles(profile.id).map((role) => `${definition}${profile.id}/${role}-shape`),
    );
    const entry = published.profiles.find((item) => item.id === profile.id)!;
    expect(entry.focusRoles).toEqual(roles(profile.id));
    expect(published.shapes.get(entry.file)).toBe(profileSource(profile));
    expect(entry.sha256).toBe(digest(profileSource(profile)));
    expect(entry.sha256).not.toBe(original[profile.id as keyof typeof original][0]);
  }
  for (const [id, hash] of Object.entries(derived))
    expect(digest(constraints(authoredProfiles.find((profile) => profile.id === id)!))).toBe(hash);
  for (const [, module] of modules) {
    expect(Object.keys(module)).toHaveLength(1);
    for (const [name, declaration] of Object.entries(module)) {
      expect(name.endsWith('Declaration')).toBe(true);
      expect(Object.keys(declaration).sort()).toEqual(['binding', 'canonical', 'id']);
    }
  }
  const global = discovered.filter((profile) => profile.id.startsWith('global-'));
  expect(global[0]!.binding).toEqual({
    required: ['context', 'question'],
    roles: ['context'],
    demandedBy: ['rv:GlobalRatingContext'],
  });
  expect(global[0]!.shapes[0]!.canonical).toEqual({ types: ['rv:GlobalRatingContext'] });
  expect(global[1]!.binding).toEqual({
    required: ['context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:GlobalRatingObservation', 'rv:GlobalRatingObservationRevision'],
  });
  expect(global[1]!.shapes[3]!.canonical).toEqual({ types: ['rv:GlobalRatingObservation'] });
  expect(global[1]!.shapes[4]!.canonical).toEqual({
    types: ['rv:GlobalRatingObservationRevision'],
  });
});

test('rating author reload changes current digests while historical pinned bytes and records remain exact', () => {
  const path = directory();
  const historicalProfiles = profiles.map((profile) => {
    const source = profileSource(profile);
    expect(source.endsWith(authorComment)).toBe(true);
    const pinnedBytes = source.slice(0, -authorComment.length);
    expect(digest(pinnedBytes)).toBe(original[profile.id as keyof typeof original][0]);
    const declaration = profile.id.startsWith('global-')
      ? {
          id: profile.id,
          binding: profile.binding,
          canonical: Object.fromEntries(
            profile.shapes
              .filter((shape) => shape.canonical)
              .map((shape) => [shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical!]),
          ),
        }
      : undefined;
    return parseTurtleProfile(profile.id, pinnedBytes, declaration);
  });
  const historical = commandProfiles(historicalProfiles, options);
  const records = historical.profiles.map((profile) => ({
    profile: profile.id,
    shapeSha256: profile.sha256,
    revision: 'urn:rating:retained-revision',
  }));
  const retained = structuredClone({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  });
  const current = commandProfiles(profiles, options);
  for (const profile of profiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Whitespace-only author reload.\n`,
    );
  const reloaded = discoverProfiles(path, modules);
  const changed = commandProfiles(reloaded, options);
  for (const [index, profile] of profiles.entries()) {
    expect(changed.profiles[index]!.sha256).not.toBe(current.profiles[index]!.sha256);
    expect(changed.profiles[index]!.sha256).toBe(digest(profileSource(reloaded[index]!)));
    expect(constraints(reloaded[index]!)).toBe(constraints(profile));
    expect(historical.profiles[index]!.sha256).toBe(
      original[profile.id as keyof typeof original][0],
    );
    expect(digest(historical.shapes.get(historical.profiles[index]!.file)!)).toBe(
      historical.profiles[index]!.sha256,
    );
  }
  expect(commandProfiles(historicalProfiles, options).manifest).toEqual(retained.manifest);
  expect(commandProfiles(historicalProfiles, options).profiles).toEqual(retained.profiles);
  expect([...commandProfiles(historicalProfiles, options).shapes]).toEqual(retained.shapes);
  expect({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  }).toEqual(retained);
});

test('rating contexts preserve fixed numeric scales and reject wrong scalar, null and English question envelopes', async () => {
  for (const id of ids) {
    const valid = context(id);
    expect(await accepts(id, 'context', valid)).toBe(true);
    for (const value of ['1', null, 1.5, 0, 2])
      expect(await accepts(id, 'context', { ...valid, 'rv:ratingScaleMin': [value] })).toBe(false);
    for (const value of [[], [id.startsWith('global-') ? 10 : 5], ['10'], null, 10])
      expect(await accepts(id, 'context', { ...valid, 'rv:ratingScaleMax': value })).toBe(false);
    if (id.endsWith('context-v1')) {
      for (const value of [
        null,
        'How was it?',
        [],
        ['How was it?'],
        [{ '@value': 'How was it?' }],
        [{ '@value': 'How was it?', '@language': 'fr' }],
        [{ '@value': 'How was it?', '@language': 'EN' }],
        [{ '@value': 'No', '@language': 'en' }],
        [{ '@value': 'x'.repeat(121), '@language': 'en' }],
        [
          { '@value': 'How was it?', '@language': 'en' },
          { '@value': 'Another?', '@language': 'en' },
        ],
      ])
        expect(await accepts(id, 'context', { ...valid, 'rv:question': value })).toBe(false);
    }
    if (id.startsWith('global-')) {
      expect(await accepts(id, 'context', { ...valid, 'rv:realm': ['urn:rating:realm'] })).toBe(
        false,
      );
      expect(
        await accepts(id, 'context', { ...valid, 'rv:ratingPopulationOwner': ['urn:other:owner'] }),
      ).toBe(false);
    }
  }
});

test('rating Available and Withdrawn branches preserve required bounded values and omission', async () => {
  for (const id of ids.filter((value) => value.endsWith('observation-v1'))) {
    const valid = revision(id);
    const maximum = id.startsWith('global-') ? 5 : 10;
    for (const value of [1, maximum])
      expect(await accepts(id, 'revision', { ...valid, 'rv:ratingValue': [value] })).toBe(true);
    const { 'rv:ratingValue': omitted, ...withoutValue } = valid;
    expect(omitted).toEqual([maximum]);
    expect(await accepts(id, 'revision', withoutValue)).toBe(false);
    for (const value of [[], [0], [maximum + 1], [-1], [1.5], ['1'], [null], [1, 2], 1, null])
      expect(await accepts(id, 'revision', { ...valid, 'rv:ratingValue': value })).toBe(false);
    const withdrawn = { ...withoutValue, 'rv:ratingAvailability': [`${rv}Withdrawn`] };
    expect(await accepts(id, 'revision', withdrawn)).toBe(true);
    expect(await accepts(id, 'revision', { ...withdrawn, 'rv:ratingValue': [] })).toBe(true);
    for (const value of [[1], [null], null, 1])
      expect(await accepts(id, 'revision', { ...withdrawn, 'rv:ratingValue': value })).toBe(false);
    for (const value of [
      [],
      ['Available'],
      [`${rv}Unknown`],
      [`${rv}Available`, `${rv}Withdrawn`],
      null,
      `${rv}Available`,
    ])
      expect(await accepts(id, 'revision', { ...valid, 'rv:ratingAvailability': value })).toBe(
        false,
      );
    expect(await accepts(id, 'revision', { ...valid, 'rv:evaluatedAt': ['today'] })).toBe(false);
    expect(
      await accepts(id, 'revision', {
        ...valid,
        'rv:submittedAt': [timestamp, '2026-10-08T00:00:00Z'],
      }),
    ).toBe(false);
  }
});

test('daily rating evidence retains day, zone, calendar and dateTime constraints', async () => {
  const id = 'realm-daily-rating-observation-v1';
  const valid = revision(id);
  for (const [path, value] of [
    ['rv:ratingDay', '2026-1-7'],
    ['rv:ratingDay', null],
    ['rv:ratingTimeZone', ''],
    ['rv:ratingTimeZone', 'x'.repeat(101)],
    ['rv:ratingCalendar', `${definition}rating-other-calendar-v1`],
    ['rv:periodStart', '2026-10-07'],
    ['rv:periodEnd', null],
  ] as const)
    expect(await accepts(id, 'revision', { ...valid, [path]: [value] })).toBe(false);
  const { 'rv:ratingDay': omitted, ...withoutDay } = valid;
  expect(omitted).toEqual(['2026-10-07']);
  expect(await accepts(id, 'revision', withoutDay)).toBe(false);
});

test('rating contexts map fixed numbers, language literals and availability IRIs explicitly', () => {
  for (const id of ids) {
    const context = JSON.parse(outputs.get(`generated/model/contexts/${id}.jsonld`)!)['@context'];
    expect(context['rv:ratingScaleMin']).toEqual({
      '@id': `${rv}ratingScaleMin`,
      '@type': 'xsd:integer',
    });
    expect(context['rv:ratingScaleMax']).toEqual({
      '@id': `${rv}ratingScaleMax`,
      '@type': 'xsd:integer',
    });
    if (id.endsWith('context-v1'))
      expect(context['rv:question']).toEqual({ '@id': `${rv}question` });
    else {
      expect(context['rv:ratingAvailability']).toEqual({
        '@id': `${rv}ratingAvailability`,
        '@type': '@id',
      });
      // The withdrawn branch permits no values, so the existing context leaves
      // coercion unset; the available branch's JSON schema requires integers.
      expect(context['rv:ratingValue']).toEqual({ '@id': `${rv}ratingValue` });
    }
  }
});

const derivedIds = Object.keys(derived).sort();
const derivedProfiles = authoredProfiles.filter((profile) => derivedIds.includes(profile.id));
const derivedModules = [
  ['realm-target-rating-context-v1.ts', targetContextDeclaration],
  ['realm-target-rating-observation-v1.ts', targetObservationDeclaration],
  ['realm-release-rating-context-v1.ts', releaseContextDeclaration],
  ['realm-release-rating-observation-v1.ts', releaseObservationDeclaration],
] as const;
const derivedOptions = {
  established: Object.fromEntries(
    Object.entries(establishedDeclarations).filter(([id]) => derivedIds.includes(id)),
  ),
  canonicalOrder: [],
  demandOrder: [],
};
const derivedAuthorComment = '\n# Authored SHACL constraints for derived rating evidence.\n';
// Captured after the base rating authors landed, before the derived conversion.
const derivedPins = {
  'realm-target-rating-context-v1': [
    '8ac2f366d615a08d072e4bca245ced3fa445ee88e38a946029649e32937e175f',
    '1d7f61054afb9b0ed54ac48cd1f2fcbca621ab681618e2b0b85c1e410f0c519c',
  ],
  'realm-target-rating-observation-v1': [
    'e8b4e47013cd5429e0aba55192e0587e918a3f6c136d7eb363cff6fb1df69b3a',
    '7848690ecff8fb2bf37ea3b397b94da4b0e23a1599af85f6f4731ced8ad6ac18',
  ],
  'realm-release-rating-context-v1': [
    '93e0ec9620304d11ec112f7edbf2f4b73f81325a3fe0205b37728ced114840f1',
    'fbdf2271def28af1122d7c1e151a47652e4f5c5636eab26cd9c0eaebdd24b2ef',
  ],
  'realm-release-rating-observation-v1': [
    '833450c3651be8850f268b122e3ce016c0458961dfdf1377c75f4233927a1086',
    '8342fd072bfcb11860fd58b34745d4dc9d766a8a9da14936d0641708e9038cbe',
  ],
  'realm-experience-rating-context-v1': [
    '61fdb372946dbf322cae0df072e56cfed72826e89746f4856fe4f33c4035dc48',
    '9fe38755fa951cd3e4d746c43504c04122c2b46e6d679fce86292fd9012ae3c9',
  ],
  'realm-experience-rating-observation-v1': [
    'bc1075b4e362349ffeeb01138015284f02226995ea3b210436497f86f5685bc8',
    'dc77fc5fe2d747753718ded8d069e7f3b0eb651209c952539d5f5581c4ec4ca2',
  ],
} as const;
const targetDescendants = {
  'realm-target-rating-context-v2': [
    '5e92a747d8207e6775f73ae73eb553a233f48202076040d8e2984127ab8e7235',
    'e16db9db1c9b451c40b70b11d3cc5fa739f89fe137dd555acb35bbc88885ce3d',
  ],
  'realm-target-rating-observation-v2': [
    '67148d04e208fc9c71636fbdaa928af421d7340536f76dec0dbf3297bc120f4a',
    '3ff46878dd301ab65cda5a2587d63631be5d4f09e644ac5ff708c2eafce900e3',
  ],
  'realm-target-rating-context-v3': [
    '27c88e9f8b8cf3961e3c8c3c2180e117bae1a333a7bcd9e219d03b96a69fd1da',
    '71e8d89f02314ad2e0f9e15df3f99899a44f37ca27a6ebb1e9143ac756a2d349',
  ],
  'realm-target-rating-observation-v3': [
    '308be3241e9978cc242ae489258d296b13b7abf4a094a12d3d49ade763ad7900',
    '53525d3b685094c932e5cd6ed122816ff40a58ff78e1a35ec90ebb6295e01eee',
  ],
  'realm-target-rating-context-v4': [
    '2a91f1504c082047d42d720f188946db5a95658b77652287aa2eac955f728ab3',
    '61b2044caf428ef8978aec640a51273d4db30ecc3d47f1344d1fbef7c68829cd',
  ],
  'realm-target-rating-observation-v4': [
    'b7ca4e8be9b26293a74a4b118d1b4d21336d9c82fee4f03f4bf93c3664a9d26d',
    '491d445eb078e00efc6424347039491f1d4b16b4fd9686e2c3b039780a42d61f',
  ],
} as const;
const targetDescendantPins = {
  'realm-target-rating-context-v2':
    'f772578c222dd5b628c9f933c5e94b54dcd7afd098639f68b97397f95aabaf22',
  'realm-target-rating-observation-v2':
    '84c2c5890fefa3b205a924aa2a847c005fb343e5fd8120dc103f8ca8a63bc9bd',
  'realm-target-rating-context-v3':
    '27f3fad26fee3ece32933f50432f6de7df89aa2ff63bc0278855b79d46178bf3',
  'realm-target-rating-observation-v3':
    '91992a81764f366b64c2dce1aef37952329b09c9a56a33121669c0bdbf5f48ae',
  'realm-target-rating-context-v4':
    '68ffb3005c6f57794341630ccb9db0c38d9ddaaeb0705d989aac5618ed6b2cce',
  'realm-target-rating-observation-v4':
    '6932dc8df4e44fcda7f741cbad9b8d4cb1d53efebbec90a6086b1f0f8ca63f22',
} as const;
function ownMetadata(profile: ProfileDefinition) {
  const canonical = Object.fromEntries(
    profile.shapes
      .filter((shape) => shape.canonical)
      .map((shape) => [shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical!]),
  );
  return {
    ...(Object.keys(canonical).length ? { canonical } : {}),
    ...(profile.binding ? { binding: profile.binding } : {}),
  };
}
function metadataDigest(profile: ProfileDefinition): string {
  return digest(
    JSON.stringify({
      commandMetadata: ownMetadata(profile),
      establishedCommandMetadata: establishedDeclarations[profile.id] ?? {},
    }),
  );
}
function derivedRoles(id: string): string[] {
  if (id.endsWith('context-v1')) return ['realm', 'context'];
  if (id.includes('-target-')) return ['realm', 'context', 'observation', 'revision'];
  return [
    'realm',
    'context',
    'work',
    'main',
    ...(id.includes('-release-') ? ['release'] : []),
    'observation',
    'revision',
  ];
}
const derivedOutputs = buildModelOutputs(derivedProfiles);
let derivedSchemaPromise: Promise<Record<string, TSchema>> | undefined;
async function acceptsDerived(
  id: string,
  role: string,
  node: Record<string, unknown>,
): Promise<boolean> {
  if (!derivedSchemaPromise) {
    const path = join(directory(), 'derived-schemas.ts');
    writeFileSync(path, derivedOutputs.get('packages/model/src/generated/schemas.ts')!);
    derivedSchemaPromise = import(path).then(
      (module) => module.shapeSchemas as Record<string, TSchema>,
    );
  }
  return Value.Check((await derivedSchemaPromise)[`${definition}${id}/${role}-shape`]!, node);
}
function derivedContext(id: string): Record<string, unknown> {
  const experience = id.includes('-experience-');
  return {
    ...context('realm-standing-rating-context-v1'),
    'rdf:type': experience
      ? [`${rv}RatingContext`, `${rv}ExperienceRatingContext`]
      : [`${rv}${id.includes('-target-') ? 'Target' : 'Release'}RatingContext`],
    'rv:targetGrain': [
      `${rv}${experience ? 'MainVersion' : id.includes('-target-') ? 'Release' : 'FixedRelease'}`,
    ],
    'rv:ratingCadence': [`${definition}rating-${experience ? 'experience' : 'standing'}-v1`],
  };
}
const occasion = `urn:rezics:rating-occasion:${'a'.repeat(64)}`;
function derivedObservation(id: string): Record<string, unknown> {
  const experience = id.includes('-experience-');
  return {
    '@id': 'urn:rating:observation',
    'rdf:type': experience
      ? [`${rv}RatingObservation`, `${rv}ExperienceRatingObservation`]
      : [`${rv}${id.includes('-target-') ? 'Target' : 'Release'}RatingObservation`],
    'rv:ratingContext': ['urn:rating:context'],
    'rv:ratingSlot': ['urn:rating:slot'],
    'rv:observationHead': ['urn:rating:head'],
    [experience
      ? 'rv:targetMainVersion'
      : id.includes('-target-')
        ? 'rv:target'
        : 'rv:targetRelease']: ['urn:rating:target'],
    ...(experience ? { 'rv:ratingOccasion': [occasion] } : {}),
  };
}
function derivedRevision(id: string): Record<string, unknown> {
  const experience = id.includes('-experience-');
  return {
    ...revision('realm-standing-rating-observation-v1'),
    'rdf:type': experience
      ? [`${rv}RatingObservationRevision`, `${rv}ExperienceRatingObservationRevision`]
      : [`${rv}${id.includes('-target-') ? 'Target' : 'Release'}RatingObservationRevision`],
    ...(experience ? { 'rv:ratingOccasion': [occasion] } : {}),
  };
}

test('derived rating Turtle discovery preserves six v1 constraints, focus roles and command metadata', () => {
  const path = directory();
  for (const id of derivedIds)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, derivedModules);
  expect(discovered.map((profile) => profile.id)).toEqual(derivedIds);
  expect(derivedProfiles.map((profile) => profile.id)).toEqual(derivedIds);
  const published = commandProfiles(discovered, derivedOptions);
  expect(published.manifest).toEqual(commandProfiles(derivedProfiles, derivedOptions).manifest);
  for (const profile of discovered) {
    expect(digest(constraints(profile))).toBe(derived[profile.id as keyof typeof derived]);
    expect(metadataDigest(profile)).toBe(derivedPins[profile.id as keyof typeof derivedPins][1]);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      derivedRoles(profile.id).map((role) => `${definition}${profile.id}/${role}-shape`),
    );
    const entry = published.profiles.find((item) => item.id === profile.id)!;
    expect(entry.focusRoles).toEqual(derivedRoles(profile.id));
    expect(entry.sha256).toBe(digest(profileSource(profile)));
    expect(entry.sha256).not.toBe(derivedPins[profile.id as keyof typeof derivedPins][0]);
    expect(published.shapes.get(entry.file)).toBe(profileSource(profile));
  }
  for (const [, module] of derivedModules) {
    expect(Object.keys(module)).toHaveLength(1);
    for (const [name, declaration] of Object.entries(module)) {
      expect(name.endsWith('Declaration')).toBe(true);
      expect(Object.keys(declaration).sort()).toEqual(['binding', 'canonical', 'id']);
    }
  }
});

test('derived author reload preserves exact historical pinned bytes, metadata and revision references', () => {
  const path = directory();
  const historicalProfiles = derivedProfiles.map((profile) => {
    const source = profileSource(profile);
    expect(source.endsWith(derivedAuthorComment)).toBe(true);
    const pinnedBytes = source.slice(0, -derivedAuthorComment.length);
    expect(digest(pinnedBytes)).toBe(derivedPins[profile.id as keyof typeof derivedPins][0]);
    return parseTurtleProfile(profile.id, pinnedBytes, { id: profile.id, ...ownMetadata(profile) });
  });
  const historical = commandProfiles(historicalProfiles, derivedOptions);
  const records = historical.profiles.map((profile) => ({
    profile: profile.id,
    shapeSha256: profile.sha256,
    revision: 'urn:rating:retained-derived-revision',
  }));
  const retained = structuredClone({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  });
  const before = commandProfiles(derivedProfiles, derivedOptions);
  for (const profile of derivedProfiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Author byte reload.\n`,
    );
  const reloaded = discoverProfiles(path, derivedModules);
  const after = commandProfiles(reloaded, derivedOptions);
  for (const [index, profile] of derivedProfiles.entries()) {
    expect(after.profiles[index]!.sha256).not.toBe(before.profiles[index]!.sha256);
    expect(after.profiles[index]!.sha256).toBe(digest(profileSource(reloaded[index]!)));
    expect(constraints(reloaded[index]!)).toBe(constraints(profile));
    expect(metadataDigest(reloaded[index]!)).toBe(metadataDigest(profile));
    expect(historical.profiles[index]!.sha256).toBe(
      derivedPins[profile.id as keyof typeof derivedPins][0],
    );
    expect(digest(historical.shapes.get(historical.profiles[index]!.file)!)).toBe(
      historical.profiles[index]!.sha256,
    );
  }
  const preserved = commandProfiles(historicalProfiles, derivedOptions);
  expect(preserved.manifest).toEqual(retained.manifest);
  expect(preserved.profiles).toEqual(retained.profiles);
  expect([...preserved.shapes]).toEqual(retained.shapes);
  expect({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  }).toEqual(retained);
});

test('target rating v2-v4 descendants preserve accepted constraints, focus roles and command metadata', () => {
  for (const [id, [constraintHash, metadataHash]] of Object.entries(targetDescendants)) {
    const profile = authoredProfiles.find((item) => item.id === id)!;
    expect(digest(constraints(profile))).toBe(constraintHash);
    expect(metadataDigest(profile)).toBe(metadataHash);
    expect(digest(profileSource(profile))).toBe(
      targetDescendantPins[id as keyof typeof targetDescendantPins],
    );
    const expectedRoles = derivedRoles(id.replace(/-v[234]$/, '-v1'));
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      expectedRoles.map((role) => `${definition}${id}/${role}-shape`),
    );
  }
});

test('derived rating contexts retain exact target grains, English language and fixed integer scales', async () => {
  for (const id of derivedIds) {
    const valid = derivedContext(id);
    expect(await acceptsDerived(id, 'context', valid)).toBe(true);
    const grains = id.includes('-target-')
      ? ['Release', 'Realization', 'Occurrence', 'Resource']
      : [id.includes('-release-') ? 'FixedRelease' : 'MainVersion'];
    for (const grain of grains)
      expect(
        await acceptsDerived(id, 'context', { ...valid, 'rv:targetGrain': [`${rv}${grain}`] }),
      ).toBe(true);
    for (const grain of [
      'Projection',
      'Work',
      ...(id.includes('-target-')
        ? ['MainVersion', 'FixedRelease']
        : id.includes('-release-')
          ? ['MainVersion', 'Release']
          : ['Release']),
    ])
      expect(
        await acceptsDerived(id, 'context', { ...valid, 'rv:targetGrain': [`${rv}${grain}`] }),
      ).toBe(false);
    expect(await acceptsDerived(id, 'context', { ...valid, 'rv:targetGrain': [grains[0]] })).toBe(
      false,
    );
    expect(
      await acceptsDerived(id, 'context', {
        ...valid,
        'rv:targetGrain': [`${rv}${grains[0]}`, `${rv}${grains[0]}`],
      }),
    ).toBe(false);
    for (const [path, value] of [
      ['rv:ratingScaleMin', '1'],
      ['rv:ratingScaleMin', 0],
      ['rv:ratingScaleMax', '10'],
      ['rv:ratingScaleMax', 5],
      ['rv:ratingScaleMax', null],
    ] as const)
      expect(await acceptsDerived(id, 'context', { ...valid, [path]: [value] })).toBe(false);
    if (id.endsWith('context-v1') || id.includes('-target-')) {
      for (const question of [
        ['How was it?'],
        [{ '@value': 'How was it?', '@language': 'fr' }],
        [{ '@value': 'How was it?', '@language': 'EN' }],
        [{ '@value': 'No', '@language': 'en' }],
        null,
      ])
        expect(await acceptsDerived(id, 'context', { ...valid, 'rv:question': question })).toBe(
          false,
        );
    }
  }
});

test('release ratings exclude MainVersion targets and foreign cadence; experience requires an exact occasion', async () => {
  const dailyFields = [
    'rv:ratingDay',
    'rv:ratingTimeZone',
    'rv:ratingCalendar',
    'rv:periodStart',
    'rv:periodEnd',
  ];
  for (const id of [
    'realm-release-rating-observation-v1',
    'realm-experience-rating-observation-v1',
  ]) {
    const observed = derivedObservation(id);
    const revised = derivedRevision(id);
    expect(await acceptsDerived(id, 'observation', observed)).toBe(true);
    expect(await acceptsDerived(id, 'revision', revised)).toBe(true);
    for (const path of [
      ...dailyFields,
      ...(id.includes('-release-') ? ['rv:ratingOccasion'] : []),
    ]) {
      expect(
        await acceptsDerived(id, 'observation', { ...observed, [path]: ['urn:foreign:cadence'] }),
      ).toBe(false);
      expect(
        await acceptsDerived(id, 'revision', { ...revised, [path]: ['urn:foreign:cadence'] }),
      ).toBe(false);
    }
    if (id.includes('-release-'))
      expect(
        await acceptsDerived(id, 'observation', {
          ...observed,
          'rv:targetMainVersion': ['urn:rating:main'],
        }),
      ).toBe(false);
    else {
      for (const value of [
        [],
        [occasion.toUpperCase()],
        [`urn:rezics:rating-occasion:${'a'.repeat(63)}`],
        [`https://rezics.com/rating-occasion/${'a'.repeat(64)}`],
        [null],
        null,
        occasion,
      ]) {
        expect(
          await acceptsDerived(id, 'observation', { ...observed, 'rv:ratingOccasion': value }),
        ).toBe(false);
        expect(
          await acceptsDerived(id, 'revision', { ...revised, 'rv:ratingOccasion': value }),
        ).toBe(false);
      }
      const { 'rv:ratingOccasion': omitted, ...withoutOccasion } = revised;
      expect(omitted).toEqual([occasion]);
      expect(await acceptsDerived(id, 'revision', withoutOccasion)).toBe(false);
    }
  }
  const target = 'realm-target-rating-observation-v1';
  const observed = derivedObservation(target);
  expect(await acceptsDerived(target, 'observation', observed)).toBe(true);
  for (const path of ['rv:targetMainVersion', 'rv:targetRelease'])
    expect(
      await acceptsDerived(target, 'observation', {
        ...observed,
        [path]: ['urn:rating:other-target'],
      }),
    ).toBe(false);
});

test('derived revisions admit Available integer 1-10 and require Withdrawn value omission', async () => {
  for (const id of derivedIds.filter((value) => value.endsWith('observation-v1'))) {
    const valid = derivedRevision(id);
    for (const value of [1, 10])
      expect(await acceptsDerived(id, 'revision', { ...valid, 'rv:ratingValue': [value] })).toBe(
        true,
      );
    const { 'rv:ratingValue': omitted, ...withoutValue } = valid;
    expect(omitted).toEqual([10]);
    expect(await acceptsDerived(id, 'revision', withoutValue)).toBe(false);
    for (const value of [[], [0], [11], [1.5], ['10'], [null], [1, 2], null, 10])
      expect(await acceptsDerived(id, 'revision', { ...valid, 'rv:ratingValue': value })).toBe(
        false,
      );
    const withdrawn = { ...withoutValue, 'rv:ratingAvailability': [`${rv}Withdrawn`] };
    expect(await acceptsDerived(id, 'revision', withdrawn)).toBe(true);
    expect(await acceptsDerived(id, 'revision', { ...withdrawn, 'rv:ratingValue': [] })).toBe(true);
    for (const value of [[1], [null], null])
      expect(await acceptsDerived(id, 'revision', { ...withdrawn, 'rv:ratingValue': value })).toBe(
        false,
      );
    for (const value of [[], ['Withdrawn'], [`${rv}Available`, `${rv}Withdrawn`], [null], null])
      expect(
        await acceptsDerived(id, 'revision', { ...valid, 'rv:ratingAvailability': value }),
      ).toBe(false);
  }
});
