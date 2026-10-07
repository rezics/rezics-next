import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const definition = 'https://rezics.com/definition/';
const vocabulary = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const ids = [
  'theme-activation-v1',
  // The source file was named for its feature; its persisted profile ID is first-party-bundle-v1.
  'first-party-bundle-v1',
  'theme-first-party-v1',
  'protection-revision-v1',
  'tag-proposal-concept-v1',
  'concept-scheme-revision-v1',
] as const;

const originalPins = {
  'theme-activation-v1': 'a6783b594ea6ff88743128c994707b49dc59da2d234ac3969c0a1bd5f294d8b6',
  'first-party-bundle-v1': 'a41754111c9fd3150ef4f1666b9fce2221f5e58b7aa463022d85e87b6e7bf00e',
  'theme-first-party-v1': '53e664d86fe7620d2c3fa5cf0583e8c551c0abe7ef1cf24c10c691e1a1398a40',
  'protection-revision-v1': '92a6e82e55849a2c3ab4bae1076cb8d17f18a4516870d3d46bbd7f050bcdb396',
  'tag-proposal-concept-v1': 'a671d7af426d72082e47f328093c27c6088b2496a7d4925a38cd2ba29df0ca94',
  'concept-scheme-revision-v1': 'd09696e2138aff8599880e1f445b8342679f1d6736a90596de97d881dd5801ff',
} as const;

const focusRoles = {
  'theme-activation-v1': ['theme', 'activation'],
  'first-party-bundle-v1': ['revision'],
  'theme-first-party-v1': [
    'theme', 'revision', 'review-slot', 'review', 'activation', 'revocation-slot', 'revocation',
    'control-head', 'control',
  ],
  'protection-revision-v1': ['target', 'protection'],
  'tag-proposal-concept-v1': ['concept'],
  'concept-scheme-revision-v1': ['anchor'],
} as const;

const canonicalRoutes = {
  'theme-activation-v1': [
    { role: 'theme', type: `${vocabulary}CustomTheme`, when: [] },
  ],
  'first-party-bundle-v1': [],
  'theme-first-party-v1': [
    { role: 'theme', type: `${vocabulary}FirstPartyTheme`, when: [] },
    { role: 'revision', type: `${vocabulary}FirstPartyThemeRevision`, when: [] },
    { role: 'review-slot', type: `${vocabulary}FirstPartyThemeReviewSlot`, when: [] },
    { role: 'review', type: `${vocabulary}FirstPartyThemeReview`, when: [] },
    { role: 'activation', type: `${vocabulary}FirstPartyThemeActivation`, when: [] },
    { role: 'revocation-slot', type: `${vocabulary}FirstPartyThemeRevocationSlot`, when: [] },
    { role: 'revocation', type: `${vocabulary}FirstPartyThemeRevocation`, when: [] },
    { role: 'control-head', type: `${vocabulary}FirstPartyThemeControlHead`, when: [] },
    { role: 'control', type: `${vocabulary}FirstPartyThemeControl`, when: [] },
  ],
  'protection-revision-v1': [
    { role: 'protection', type: `${vocabulary}ProtectionRevision`, when: [] },
  ],
  'tag-proposal-concept-v1': [
    { role: 'concept', type: `${vocabulary}AuthorTagConcept`, when: [] },
  ],
  'concept-scheme-revision-v1': [],
} as const;

const alternatives = {
  'theme-activation-v1': {},
  'first-party-bundle-v1': {},
  'theme-first-party-v1': {},
  'protection-revision-v1': { protection: 3 },
  'tag-proposal-concept-v1': {},
  'concept-scheme-revision-v1': {},
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const role = (iri: string) => iri.split('/').at(-1)!.slice(0, -6);
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));

test('theme and protection Turtle preserves source pins, focus, alternatives and canonical metadata', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const manifestProfiles = command.manifest.profiles as { id: string; binding?: unknown }[];
  const registryRoutes = command.manifest.canonical as {
    type: string;
    routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
  }[];

  for (const id of ids) {
    const profile = profileById.get(id)!;
    const pin = originalPins[id];
    const source = readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8');
    const routes = registryRoutes.flatMap(({ type, routes: entries }) => entries
      .filter((entry) => entry.profile === id)
      .map((entry) => ({ role: role(entry.shape), type, when: entry.when })))
      .sort((a, b) => a.role.localeCompare(b.role));

    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(focusRoles[id]);
    expect(profile.shapes.map((shape) => role(shape.iri))).toEqual(focusRoles[id]);
    expect(routes).toEqual([...canonicalRoutes[id]].sort((a, b) => a.role.localeCompare(b.role)));
    expect(Object.fromEntries(profile.shapes.flatMap((shape) => shape.or
      ? [[role(shape.iri), shape.or.length]]
      : []))).toEqual(alternatives[id]);
    expect(profile.binding).toBeUndefined();
    expect(manifestProfiles.find((entry) => entry.id === id)?.binding).toBeUndefined();
    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
  }
});

test('theme activation and first-party review fixtures retain required heads and decisions', () => {
  const theme = {
    '@id': 'urn:theme:custom',
    'rdf:type': [`${vocabulary}CustomTheme`],
    'rv:themeHead': ['urn:theme:revision'],
  };
  const resource = `https://rezics.com/id/00000000-0000-4000-8000-000000000001`;
  const review = {
    '@id': resource,
    'rdf:type': [`${vocabulary}FirstPartyThemeReview`],
    'rv:component': [resource],
    'rv:revision': [resource],
    'rv:reviewedBy': [resource],
    'rv:reviewerPrincipal': ['00000000-0000-4000-8000-000000000001'],
    'rv:decision': [`${vocabulary}Approved`],
    'rv:reviewEvidenceDigest': ['a'.repeat(64)],
  };

  expect(Value.Check(shapeSchemas[`${definition}theme-activation-v1/theme-shape`], theme)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}theme-activation-v1/theme-shape`], {
    '@id': theme['@id'],
    'rdf:type': theme['rdf:type'],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}theme-first-party-v1/review-shape`], review)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}theme-first-party-v1/review-shape`], {
    ...review,
    'rv:decision': [`${vocabulary}Pending`],
  })).toBe(false);
});

test('first-party bundle and concept fixtures keep digest, state and pinned revision constraints', () => {
  const digestValue = 'a'.repeat(64);
  const bundle = {
    '@id': 'urn:theme:bundle-revision',
    'rdf:type': [`${vocabulary}ThemePackageRevision`],
    'rv:component': ['urn:theme:bundle'],
    'rv:hostZone': ['urn:theme:zone'],
    'rv:dependencyDigest': [digestValue],
  };
  const concept = {
    '@id': 'urn:tag:concept',
    'rdf:type': [`${schema}DefinedTerm`, `${vocabulary}AuthorTagConcept`],
    'skos:prefLabel': [{ '@value': 'Chess', '@language': 'en' }],
    'rv:conceptState': [`${vocabulary}Active`],
  };
  const anchor = {
    '@id': 'urn:concept-scheme:revision-anchor',
    'rdf:type': [`${vocabulary}RevisionAnchor`],
    'rv:component': ['urn:concept-scheme:revision'],
    'rv:operation': ['urn:operation:concept-scheme'],
    'rv:recordedBy': ['urn:agent:author'],
    'rv:manifest': ['urn:manifest:concept-scheme'],
    'rv:modelRevision': [`${definition}classification-proposition-v2`],
    'rv:shapeRevision': [`${definition}classification-proposition-v2`],
  };

  expect(Value.Check(shapeSchemas[`${definition}first-party-bundle-v1/revision-shape`], bundle)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}first-party-bundle-v1/revision-shape`], {
    ...bundle,
    'rv:dependencyDigest': ['not-a-digest'],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}tag-proposal-concept-v1/concept-shape`], concept)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}tag-proposal-concept-v1/concept-shape`], {
    ...concept,
    'rv:conceptState': [`${vocabulary}Retired`],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}concept-scheme-revision-v1/anchor-shape`], anchor)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}concept-scheme-revision-v1/anchor-shape`], {
    ...anchor,
    'rv:modelRevision': [`${definition}classification-proposition-v1`],
  })).toBe(false);
});

test('protection revisions keep the three action and mode alternatives distinct', () => {
  const common = {
    '@id': 'urn:protection:revision',
    'rdf:type': [`${vocabulary}ProtectionRevision`, `${vocabulary}RevisionAnchor`],
    'rv:component': ['https://schema.org/CreativeWork:one'],
    'rv:protectedSlot': ['title:en'],
    'rv:adoptionContext': [`${vocabulary}GlobalNative`],
    'rv:protectionEpoch': [1],
    'rv:ruleRevision': ['urn:rezics:protection-rule:independent-human-review-v1'],
    'rv:workRevision': ['urn:work:revision'],
    'rv:operation': ['urn:operation:protection'],
    'rv:protectionIntent': ['review this title'],
    'rv:manifest': ['urn:manifest:protection'],
    'rv:modelRevision': [`${definition}protection-revision-v1`],
    'rv:shapeRevision': [`${definition}protection-revision-v1`],
    'rv:dataEpoch': ['epoch'],
    'rv:sequence': [1],
  };
  const shape = shapeSchemas[`${definition}protection-revision-v1/protection-shape`];

  expect(Value.Check(shape, {
    ...common,
    'rv:protectionAction': [`${vocabulary}Tighten`],
    'rv:protectionMode': [`${vocabulary}ReviewRequired`],
  })).toBe(true);
  expect(Value.Check(shape, {
    ...common,
    'rv:protectionAction': [`${vocabulary}Confirm`],
    'rv:protectionMode': [`${vocabulary}ReviewRequired`],
    'rv:controlRevision': ['urn:control:revision'],
  })).toBe(true);
  expect(Value.Check(shape, {
    ...common,
    'rv:protectionAction': [`${vocabulary}Relax`],
    'rv:protectionMode': [`${vocabulary}Open`],
    'rv:predecessor': ['urn:protection:prior-revision'],
  })).toBe(true);
  expect(Value.Check(shape, {
    ...common,
    'rv:protectionAction': [`${vocabulary}Tighten`],
    'rv:protectionMode': [`${vocabulary}Open`],
  })).toBe(false);
});
