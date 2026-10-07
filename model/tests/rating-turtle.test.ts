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
