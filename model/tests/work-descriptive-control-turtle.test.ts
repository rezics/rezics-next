import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { shapeRole } from '../compiler/registry.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const definition = 'https://rezics.com/definition/';
const rv = 'https://rezics.com/vocab/';
const ids = [
  'work-editorial-field-v1',
  'work-title-control-v2',
  'work-derivation-v2',
  'definition-key-v1',
] as const;
const originalPins = {
  'work-editorial-field-v1': '61a93b0c3f403a3450545c063cabfb8d12299586df48dbd4c9574d8831b30999',
  'work-title-control-v2': 'deeee87603c9babb4211ffc0fd37c8523a88addbe1e56cf2a3aa9fa3769173d8',
  'work-derivation-v2': '629ed8a8a60013eecc334a84298687e02c57dbaf75d201f49bb9d3b597abd634',
  'definition-key-v1': '156050d35d5a7723cd89361e3ae919b1b6ec4f2f19592a0782ad45816dc09e5f',
} as const;
const focusRoles = {
  'work-editorial-field-v1': ['slot', 'value', 'control'],
  'work-title-control-v2': ['control'],
  'work-derivation-v2': ['derivation'],
  'definition-key-v1': ['key'],
} as const;
const expectedCanonical = {
  'work-editorial-field-v1': [{ role: 'slot', type: `${rv}EditorialFieldSlot`, when: [] }],
  'work-title-control-v2': [
    {
      role: 'control',
      type: `${rv}EditorialControlRevision`,
      when: [{ path: `${rv}modelRevision`, value: `${definition}work-title-control-v2` }],
    },
  ],
  'work-derivation-v2': [{ role: 'derivation', type: `${rv}LexiconWorkDerivation`, when: [] }],
  'definition-key-v1': [{ role: 'key', type: `${rv}DefinitionKey`, when: [] }],
} as const;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));
const iri = (name: string) => `urn:work-descriptive-control:${name}`;
const node = (name: string, types: string[], properties: Record<string, unknown>) => ({
  '@id': iri(name),
  'rdf:type': types,
  ...properties,
});
const changed = <T extends object>(
  value: T,
  name: string,
  properties: Record<string, unknown>,
) => ({
  ...value,
  '@id': iri(name),
  ...properties,
});
const missing = <T extends object>(value: T, name: string, property: string) => {
  const result: Record<string, unknown> = { ...value, '@id': iri(name) };
  delete result[property];
  return result;
};
const shapeSchema = (id: string, role: string) =>
  shapeSchemas[`${definition}${id}/${role}-shape` as keyof typeof shapeSchemas];

const editorialSlot = node('editorial-slot', [`${rv}EditorialFieldSlot`], {
  'rv:component': [iri('work')],
  'rv:fieldDefinition': [`${definition}work-synopsis-v1`],
  'rv:fieldValue': ['A short synopsis.'],
  'rv:fieldHead': [iri('field-revision')],
  'rv:fieldControlHead': [iri('field-control')],
});
const editorialValue = node(
  'editorial-value',
  [`${rv}EditorialFieldRevision`, `${rv}RevisionAnchor`],
  {
    'rv:component': [iri('field-slot')],
    'rv:fieldValue': ['A short synopsis.'],
    'rv:rightsStatus': [`${rv}Undetermined`],
    'rv:modelRevision': [`${definition}work-editorial-field-v1`],
    'rv:shapeRevision': [`${definition}work-editorial-field-v1`],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  },
);
const editorialControl = node(
  'editorial-control',
  [`${rv}EditorialFieldControlRevision`, `${rv}RevisionAnchor`],
  {
    'rv:component': [iri('field-slot')],
    'rv:controlField': ['synopsis'],
    'rv:controlMode': [`${rv}HumanControlled`],
    'rv:controlEpoch': [1],
    'rv:fieldRevision': [iri('field-revision')],
    'rv:controlIntent': ['Review the synopsis.'],
    'rv:modelRevision': [`${definition}work-editorial-field-v1`],
    'rv:shapeRevision': [`${definition}work-editorial-field-v1`],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  },
);
const titleControl = node(
  'title-control',
  [`${rv}EditorialControlRevision`, `${rv}RevisionAnchor`],
  {
    'rv:component': [iri('work')],
    'rv:controlField': ['title'],
    'rv:controlLanguage': ['en-US'],
    'rv:controlMode': [`${rv}SourceManaged`],
    'rv:controlEpoch': [1],
    'rv:workRevision': [iri('work-revision')],
    'rv:operation': [iri('operation')],
    'rv:controlIntent': ['Use the reviewed source title.'],
    'rv:manifest': [iri('manifest')],
    'rv:modelRevision': [`${definition}work-title-control-v2`],
    'rv:shapeRevision': [`${definition}work-title-control-v2`],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  },
);
const derivationBase = (name: string, status: 'Exact' | 'Unresolved', sourceVersion?: boolean) =>
  node(name, [`${rv}LexiconWorkDerivation`], {
    'rv:targetWork': [iri('target-work')],
    'rv:targetMainVersion': [iri('target-main')],
    'rv:targetMainRevision': [iri('target-revision')],
    'rv:sourceWork': [iri('source-work')],
    ...(sourceVersion
      ? {
          'rv:sourceMainVersion': [iri('source-main')],
          'rv:sourceMainRevision': [iri('source-revision')],
        }
      : {}),
    'rv:sourceVersionStatus': [`${rv}${status}`],
    'rv:derivationKind': [iri('kind-definition-revision')],
    'rv:evidence': ['https://evidence.example/source'],
    'rv:linkedBy': [iri('agent')],
    'rv:modelRevision': [`${definition}work-derivation-v2`],
    'rv:shapeRevision': [`${definition}work-derivation-v2`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  });
const exactDerivation = derivationBase('exact-derivation', 'Exact', true);
const unresolvedDerivation = derivationBase('unresolved-derivation', 'Unresolved');
const definitionKey = node('definition-key', [`${rv}DefinitionKey`], {
  'rv:keyDefinition': [iri('semantic-definition')],
  'skos:notation': ['lexicon-key-1'],
});

const validationCases = [
  {
    id: 'work-editorial-field-v1',
    role: 'slot',
    valid: editorialSlot,
    invalid: missing(editorialSlot, 'editorial-slot-missing-control', 'rv:fieldControlHead'),
  },
  {
    id: 'work-editorial-field-v1',
    role: 'value',
    valid: editorialValue,
    invalid: changed(editorialValue, 'editorial-value-invalid-rights', {
      'rv:rightsStatus': [`${rv}Claimed`],
    }),
  },
  {
    id: 'work-editorial-field-v1',
    role: 'control',
    valid: editorialControl,
    invalid: changed(editorialControl, 'editorial-control-invalid-mode', {
      'rv:controlMode': [`${rv}Unknown`],
    }),
  },
  {
    id: 'work-title-control-v2',
    role: 'control',
    valid: titleControl,
    invalid: changed(titleControl, 'title-control-invalid-language', {
      'rv:controlLanguage': ['x'.repeat(36)],
    }),
  },
  {
    id: 'work-derivation-v2',
    role: 'derivation',
    valid: exactDerivation,
    invalid: changed(exactDerivation, 'exact-derivation-unresolved-with-revision', {
      'rv:sourceVersionStatus': [`${rv}Unresolved`],
    }),
  },
  {
    id: 'work-derivation-v2',
    role: 'derivation',
    valid: unresolvedDerivation,
    invalid: changed(unresolvedDerivation, 'unresolved-derivation-marked-exact', {
      'rv:sourceVersionStatus': [`${rv}Exact`],
    }),
  },
  {
    id: 'definition-key-v1',
    role: 'key',
    valid: definitionKey,
    invalid: changed(definitionKey, 'definition-key-invalid-notation', {
      'skos:notation': ['Lexicon-key-1'],
    }),
  },
] as const;

test('descriptive Work Turtle preserves exact source pins, focus, canonical routes and binding demands', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const manifestProfiles = command.manifest.profiles as { id: string; binding?: unknown }[];
  const canonical = command.manifest.canonical as {
    type: string;
    routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
  }[];
  const sourceById = Object.fromEntries(
    ids.map((id) => [
      id,
      readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8'),
    ]),
  ) as Record<string, string>;

  for (const id of ids) {
    const profile = profileById.get(id)!;
    const source = sourceById[id]!;
    const record = published.get(id)!;
    const routes = canonical
      .flatMap(({ type, routes: entries }) =>
        entries
          .filter((route) => route.profile === id)
          .map((route) => ({ role: shapeRole(id, route.shape), type, when: route.when })),
      )
      .sort((left, right) => left.role.localeCompare(right.role));

    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(digest(source)).toBe(originalPins[id]);
    expect(profileRegistry[id].sha256).toBe(originalPins[id]);
    expect(record.sha256).toBe(originalPins[id]);
    expect(record.focusRoles).toEqual(focusRoles[id]);
    expect(profile.shapes.map((shape) => shapeRole(id, shape.iri))).toEqual(focusRoles[id]);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
    expect(routes).toEqual(expectedCanonical[id]);

    const hasBinding = id === 'work-derivation-v2';
    expect(profile.binding).toEqual(
      hasBinding
        ? {
            required: [
              'derivation',
              'target-work',
              'target-main',
              'target-revision',
              'source-work',
              'kind',
              'evidence',
              'actor',
              'receipt',
              'scope',
              'epoch',
            ],
            optional: ['source-main', 'source-revision'],
            roles: ['derivation'],
            demandedBy: ['rv:LexiconWorkDerivation'],
          }
        : undefined,
    );
    expect(manifestProfiles.find((item) => item.id === id)?.binding).toEqual(
      hasBinding
        ? {
            optional: ['source-main', 'source-revision'],
            required: [
              'derivation',
              'target-work',
              'target-main',
              'target-revision',
              'source-work',
              'kind',
              'evidence',
              'actor',
              'receipt',
              'scope',
              'epoch',
            ],
            roles: ['derivation'],
          }
        : undefined,
    );
  }
  expect(
    (command.manifest.bindingDemands as { type: string; profile: string }[]).filter(({ profile }) =>
      ids.includes(profile as (typeof ids)[number]),
    ),
  ).toEqual([{ type: `${rv}LexiconWorkDerivation`, profile: 'work-derivation-v2' }]);
});

test('descriptive Work shapes keep useful valid and invalid TypeBox cases', () => {
  for (const { id, role, valid, invalid } of validationCases) {
    const schema = shapeSchema(id, role);
    expect(Value.Check(schema, valid), `${id}/${role} accepts its valid example`).toBe(true);
    expect(Value.Check(schema, invalid), `${id}/${role} rejects its invalid example`).toBe(false);
  }
  expect(
    Value.Check(shapeSchema('definition-key-v1', 'key'), {
      ...definitionKey,
      'rv:unreviewed': ['extra'],
    }),
  ).toBe(false);
});
