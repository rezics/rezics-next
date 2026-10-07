import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { shapeRole } from '../compiler/registry.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const definition = 'https://rezics.com/definition/';
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const ids = [
  'content-publication-v1',
  'realization-v1',
  'web-publication-v1',
  'web-snapshot-v1',
  'hub-item-v1',
  'main-package-release-recommendation-v1',
] as const;
const sourceFiles = {
  'content-publication-v1': 'content-publication-v1.ttl',
  'realization-v1': 'realization-v1.ttl',
  'web-publication-v1': 'web-publication-v1.ttl',
  'web-snapshot-v1': 'web-snapshot-v1.ttl',
  'hub-item-v1': 'hub-item-v1.ttl',
  'main-package-release-recommendation-v1': 'main-package-release-recommendation-v1.ttl',
} as const;
const originalPins = {
  'content-publication-v1': '19f83eac251b0e11dcae8cfe4d69a02f311133d979bf4fabb4f92f4dc0b5736f',
  'realization-v1': '34b07501a3152ca77550605d2839ced63cc8ffbdfaa5671ee1900d796047ca21',
  'web-publication-v1': '66ec301e867ac91a0e349d6411f2617f15196440b8520d2b56b9c43fdbc29fea',
  'web-snapshot-v1': '97defb2563a74cc56ae4dad08e8b6c75165c31c2b23574cb70d734d0b891365d',
  'hub-item-v1': 'd5a9c3598792cac47e1301ef9704551df121e50988643d0c1274583436bb0da8',
  'main-package-release-recommendation-v1':
    '2560da59cda40c7ac9fd0fb38b39e2d63666e6fdb06dccf250728d7d28faab60',
} as const;
const focusRoles = {
  'content-publication-v1': ['variant', 'decision'],
  'realization-v1': ['realization', 'revision'],
  'web-publication-v1': ['publication'],
  'web-snapshot-v1': ['snapshot'],
  'hub-item-v1': ['skill-package', 'prompt-template'],
  'main-package-release-recommendation-v1': ['set', 'recommendation'],
} as const;
const expectedCanonical = {
  'content-publication-v1': [
    { role: 'decision', type: `${rv}ContentPublicationDecision`, when: [] },
    { role: 'variant', type: `${rv}ContentVariant`, when: [] },
  ],
  'realization-v1': [
    { role: 'realization', type: `${rv}Realization`, when: [] },
    { role: 'revision', type: `${rv}RealizationRevision`, when: [] },
  ],
  'web-publication-v1': [],
  'web-snapshot-v1': [{ role: 'snapshot', type: `${rv}WebSnapshot`, when: [] }],
  'hub-item-v1': [],
  'main-package-release-recommendation-v1': [],
} as const;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));
const iri = (name: string) => `urn:publication-realization:${name}`;
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

const contentVariant = node('content-variant', [`${rv}ContentVariant`], {
  'rv:resource': [iri('resource')],
  'rv:contentPublicationHead': [iri('content-head')],
});
const contentDecision = node(
  'content-decision',
  [`${rv}ContentPublicationDecision`, `${rv}RevisionAnchor`],
  {
    'rv:component': [iri('content-variant')],
    'rv:operation': [`urn:rezics:operation:${'a'.repeat(64)}`],
    'rv:contentRevision': ['urn:rezics:content:revision:12345678-1234-1234-1234-123456789abc'],
    'rv:contentPreparation': ['accepted'],
    'rv:resource': [iri('resource')],
    'rv:byteDigest': ['b'.repeat(64)],
    'rv:contentFormat': ['rezics-content-json-v1'],
    'rv:contentModel': ['content-v1'],
    'rv:contentLanguageKind': ['tag'],
    'rv:contentLanguage': ['en'],
    'rv:contentDirection': ['ltr'],
    'rv:ownerDataEpoch': ['12345678-1234-1234-1234-123456789abc'],
    'rv:ownerSequence': ['0'],
    'rv:modelRevision': [`${definition}content-publication-v1`],
    'rv:shapeRevision': [`${definition}content-publication-v1`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['12345678-1234-1234-1234-123456789abc'],
    'rv:sequence': [1],
  },
);
const realization = node('realization', [`${rv}Realization`], {
  'rv:work': [iri('work')],
  'rv:head': [iri('realization-revision')],
  'rv:contentLanguage': ['en'],
  'rv:realizationKind': ['translation'],
  'rv:realizationStatus': ['official'],
  'rv:verification': ['verified'],
});
const realizationRevision = node(
  'realization-revision',
  [`${rv}RealizationRevision`, `${rv}RevisionAnchor`],
  {
    'rv:component': [iri('realization')],
    'rv:realizationState': ['{}'],
    'rv:sourceWork': [iri('source-work')],
    'rv:sourceStatus': ['unresolved'],
    'rv:manifest': [iri('manifest')],
    'rv:modelRevision': [`${definition}realization-v1`],
    'rv:shapeRevision': [`${definition}realization-v1`],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  },
);
const webPublication = node('web-publication', [`${rv}Release`], {
  'rv:releaseKind': ['web'],
  'rv:originalUrl': ['https://example.test/'],
});
const webSnapshot = node('web-snapshot', [`${rv}WebSnapshot`], {
  'rv:publication': [iri('release')],
  'rv:work': [iri('work')],
  'rv:fetchedAt': ['2026-10-07T00:00:00Z'],
  'rv:byteDigest': ['c'.repeat(64)],
  'rv:byteLength': [1],
  'rv:coverageScope': ['complete page'],
  'rv:coverageComplete': ['true'],
  'rv:object': [iri('object')],
  'rv:acquisition': ['fixture'],
});
const hubSkill = node('hub-skill', [`${schema}CreativeWork`, `${rv}SkillPackage`], {
  'rv:mainVersion': [iri('main-version')],
  'rv:modelRevision': [`${definition}hub-item-v1`],
  'rv:shapeRevision': [`${definition}hub-item-v1`],
});
const hubPrompt = node('hub-prompt', [`${schema}CreativeWork`, `${rv}PromptTemplate`], {
  'rv:mainVersion': [iri('main-version')],
  'rv:modelRevision': [`${definition}hub-item-v1`],
  'rv:shapeRevision': [`${definition}hub-item-v1`],
});
const recommendationSet = node('recommendation-set', [`${rv}PackageReleaseRecommendationSet`], {
  'rv:work': [iri('work')],
  'rv:mainVersion': [iri('main-version')],
  'rv:modelRevision': [`${definition}main-package-release-recommendation-v1`],
  'rv:shapeRevision': [`${definition}main-package-release-recommendation-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['12345678-1234-1234-1234-123456789abc'],
  'rv:sequence': [1],
});
const recommendation = node('recommendation', [`${rv}PackageReleaseRecommendation`], {
  'rv:ecosystem': ['npm'],
  'rv:packageName': ['rezics'],
  'rv:selectorKind': [`${rv}VersionConstraint`],
  'rv:selector': ['^1.2'],
  'rv:position': [0],
});
const validationCases = [
  {
    id: 'content-publication-v1',
    role: 'variant',
    valid: contentVariant,
    invalid: missing(contentVariant, 'content-variant-missing-head', 'rv:contentPublicationHead'),
  },
  {
    id: 'content-publication-v1',
    role: 'decision',
    valid: contentDecision,
    invalid: missing(contentDecision, 'content-decision-missing-language', 'rv:contentLanguage'),
  },
  {
    id: 'realization-v1',
    role: 'realization',
    valid: realization,
    invalid: changed(realization, 'realization-invalid-kind', {
      'rv:realizationKind': ['adaptation'],
    }),
  },
  {
    id: 'realization-v1',
    role: 'revision',
    valid: realizationRevision,
    invalid: changed(realizationRevision, 'revision-conflicting-source', {
      'rv:sourceRevision': [iri('source-revision')],
    }),
  },
  {
    id: 'web-publication-v1',
    role: 'publication',
    valid: webPublication,
    invalid: changed(webPublication, 'web-publication-invalid-kind', {
      'rv:releaseKind': ['formal'],
    }),
  },
  {
    id: 'web-snapshot-v1',
    role: 'snapshot',
    valid: webSnapshot,
    invalid: changed(webSnapshot, 'web-snapshot-invalid-digest', { 'rv:byteDigest': ['bad'] }),
  },
  {
    id: 'hub-item-v1',
    role: 'skill-package',
    valid: hubSkill,
    invalid: changed(hubSkill, 'hub-skill-invalid-kind', {
      'rdf:type': [`${schema}CreativeWork`, `${rv}PromptTemplate`],
    }),
  },
  {
    id: 'hub-item-v1',
    role: 'prompt-template',
    valid: hubPrompt,
    invalid: missing(hubPrompt, 'hub-prompt-missing-main-version', 'rv:mainVersion'),
  },
  {
    id: 'main-package-release-recommendation-v1',
    role: 'set',
    valid: recommendationSet,
    invalid: changed(recommendationSet, 'recommendation-set-invalid-epoch', {
      'rv:dataEpoch': ['epoch'],
    }),
  },
  {
    id: 'main-package-release-recommendation-v1',
    role: 'recommendation',
    valid: recommendation,
    invalid: changed(recommendation, 'recommendation-invalid-position', { 'rv:position': [16] }),
  },
] as const;

test('publication and realization Turtle preserves source pins, focus roles, canonical routes and bindings', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const canonical = command.manifest.canonical as {
    type: string;
    routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
  }[];
  const manifestProfiles = command.manifest.profiles as { id: string; binding?: unknown }[];

  for (const id of ids) {
    const profile = profileById.get(id)!;
    const source = readFileSync(
      new URL(`../definitions/${sourceFiles[id]}`, import.meta.url),
      'utf8',
    );
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
    expect(profile.shapes.map((item) => shapeRole(id, item.iri))).toEqual(focusRoles[id]);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
    expect(routes).toEqual(expectedCanonical[id]);

    const hasBinding = id === 'realization-v1';
    expect(profile.binding).toEqual(
      hasBinding
        ? {
            required: ['realization', 'revision'],
            roles: ['realization', 'revision'],
            demandedBy: ['rv:RealizationRevision'],
          }
        : undefined,
    );
    expect(manifestProfiles.find((item) => item.id === id)?.binding).toEqual(
      hasBinding
        ? {
            optional: [],
            required: ['realization', 'revision'],
            roles: ['realization', 'revision'],
          }
        : undefined,
    );
  }
  expect(
    (command.manifest.bindingDemands as { type: string; profile: string }[]).filter(({ profile }) =>
      ids.includes(profile as (typeof ids)[number]),
    ),
  ).toEqual([{ type: `${rv}RealizationRevision`, profile: 'realization-v1' }]);
});

test('publication and realization shapes retain useful local acceptance and rejection cases', () => {
  for (const { id, role, valid, invalid } of validationCases) {
    const schema = shapeSchema(id, role);
    expect(Value.Check(schema, valid), `${id}/${role} accepts its valid example`).toBe(true);
    expect(Value.Check(schema, invalid), `${id}/${role} rejects its invalid example`).toBe(false);
  }
});
