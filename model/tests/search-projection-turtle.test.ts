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
const ids = [
  'content-match-unit-v1',
  'content-private-match-unit-v1',
  'content-search-eligibility-v1',
  'content-search-eligibility-v2',
  'projection-v1',
  'name-registry-cleanup-v1',
] as const;

const originalPins = {
  'content-match-unit-v1': 'c6f7c934542fc58d4680f9d050917e4834dd26cdea825c408cf2f8cb8aca7090',
  'content-private-match-unit-v1': '4eb2fbcc066dc0a4b900e106425893e440787091d345997cff6b04fc6b390a1c',
  'content-search-eligibility-v1': 'b8d630d9b5206bbdff3b979f815ac41a537d6569667b4859198896d56a22d3c1',
  'content-search-eligibility-v2': 'a5c815048b2d021e85d03bcd041b2c5bd26a655daff4ff4476f5cc82402351da',
  'projection-v1': 'ae5725234cc9a9c3404dd5e17cf3c8da73d00dfa1e7578bcf45fdbe61ba920e0',
  'name-registry-cleanup-v1': '72c16910157a5eeaafe965a11817f926259c09bc79ae7d21cdbc978646a380bf',
} as const;

const focusRoles = {
  'content-match-unit-v1': ['projection', 'unit'],
  'content-private-match-unit-v1': ['state', 'projection', 'unit'],
  'content-search-eligibility-v1': ['decision'],
  'content-search-eligibility-v2': ['decision'],
  'projection-v1': ['projection', 'revision'],
  'name-registry-cleanup-v1': ['cleaned'],
} as const;

const canonicalRoutes = {
  'content-match-unit-v1': [
    { role: 'projection', type: `${vocabulary}ContentProjection`, when: [] },
  ],
  'content-private-match-unit-v1': [
    { role: 'state', type: `${vocabulary}ContentPrivateSearchState`, when: [] },
    { role: 'projection', type: `${vocabulary}ContentPrivateProjection`, when: [] },
  ],
  'content-search-eligibility-v1': [
    {
      role: 'decision',
      type: `${vocabulary}ContentSearchEligibilityDecision`,
      when: [{
        path: `${vocabulary}modelRevision`,
        value: `${definition}content-search-eligibility-v1`,
      }],
    },
  ],
  'content-search-eligibility-v2': [
    {
      role: 'decision',
      type: `${vocabulary}ContentSearchEligibilityDecision`,
      when: [{
        path: `${vocabulary}modelRevision`,
        value: `${definition}content-search-eligibility-v2`,
      }],
    },
  ],
  'projection-v1': [
    { role: 'projection', type: `${vocabulary}Projection`, when: [] },
    { role: 'revision', type: `${vocabulary}ProjectionRevision`, when: [] },
  ],
  'name-registry-cleanup-v1': [
    { role: 'cleaned', type: `${vocabulary}RetiredNameProjection`, when: [] },
  ],
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const role = (iri: string) => iri.split('/').at(-1)!.slice(0, -6);
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));

test('search and projection Turtle preserves original pins, focus roles, canonical routes and bindings', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const commandBindings = command.manifest.profiles as { id: string; binding?: unknown }[];
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
      .map((entry) => ({ role: role(entry.shape), type, when: entry.when }))
      .sort((a, b) => a.role.localeCompare(b.role)));

    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(focusRoles[id]);
    expect(profile.shapes.map((shape) => role(shape.iri))).toEqual(focusRoles[id]);
    expect(isTurtleProfile(profile)).toBe(true);
    expect(routes).toEqual([...canonicalRoutes[id]].sort((a, b) => a.role.localeCompare(b.role)));
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
    expect(Boolean(commandBindings.find((entry) => entry.id === id)?.binding))
      .toBe(id === 'projection-v1');
  }

  const projection = profileById.get('projection-v1')!;
  expect(projection.binding).toEqual({
    required: ['projection', 'revision'],
    roles: ['projection', 'revision'],
    demandedBy: ['rv:Projection', 'rv:ProjectionRevision'],
  });
  expect(commandBindings.find((entry) => entry.id === 'projection-v1')?.binding).toEqual({
    optional: [],
    required: ['projection', 'revision'],
    roles: ['projection', 'revision'],
  });
});

test('content search eligibility distinguishes original contribution from assessed public domain', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const eligibility = (
    version: 'v1' | 'v2',
    rightsBasis: 'OriginalContribution' | 'PublicDomain',
    includeAssessment = version === 'v2',
  ) => ({
    '@id': `urn:content:eligibility:${version}`,
    'rdf:type': [
      `${vocabulary}ContentSearchEligibilityDecision`,
      `${vocabulary}RevisionAnchor`,
    ],
    'rv:component': ['urn:content:eligibility'],
    'rv:variant': ['urn:content:variant'],
    'rv:resource': ['urn:content:resource'],
    'rv:publicationDecision': ['urn:content:publication-decision'],
    'rv:rightsBasis': [`${vocabulary}${rightsBasis}`],
    ...(includeAssessment ? { 'rv:rightsAssessment': ['urn:rights:assessment'] } : {}),
    'rv:disclosure': [`${vocabulary}Public`],
    'rv:admissionId': [uuid],
    'rv:authorityEpoch': ['1'],
    'rv:admittedScope': ['work'],
    'rv:actingSubject': ['urn:agent:reader'],
    'rv:modelRevision': [`${definition}content-search-eligibility-${version}`],
    'rv:shapeRevision': [`${definition}content-search-eligibility-${version}`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': [uuid],
    'rv:sequence': [1],
  });
  const v1 = shapeSchemas[`${definition}content-search-eligibility-v1/decision-shape`];
  const v2 = shapeSchemas[`${definition}content-search-eligibility-v2/decision-shape`];

  expect(Value.Check(v1, eligibility('v1', 'OriginalContribution'))).toBe(true);
  expect(Value.Check(v1, eligibility('v1', 'PublicDomain'))).toBe(false);
  expect(Value.Check(v2, eligibility('v2', 'PublicDomain'))).toBe(true);
  expect(Value.Check(v2, eligibility('v2', 'PublicDomain', false))).toBe(false);
});

test('public and private MatchUnits retain their disclosure and language value constraints', () => {
  const revision = 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000001';
  const shared = {
    '@id': 'urn:content:match-unit',
    'rdf:type': [`${vocabulary}MatchUnit`],
    'rv:resource': ['urn:content:resource'],
    'rv:variant': ['urn:content:variant'],
    'rv:revision': [revision],
    'rv:language': ['en'],
    'rv:field': [`${vocabulary}Body`],
  };
  const publicUnit = {
    ...shared,
    'rv:publicationDecision': ['urn:content:publication-decision'],
    'rv:eligibility': ['urn:content:eligibility'],
    'rv:projection': ['urn:content:projection'],
    'rv:disclosure': [`${vocabulary}Public`],
    'rv:searchBody': [{ '@value': 'Readable body', '@language': 'en' }],
  };
  const privateUnit = {
    ...shared,
    'rv:projection': ['urn:content:private-projection'],
    'rv:disclosure': [`${vocabulary}Private`],
    'rv:privateSearchBody': [{ '@value': 'Draft body', '@language': 'en' }],
  };

  expect(Value.Check(shapeSchemas[`${definition}content-match-unit-v1/unit-shape`], publicUnit)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}content-match-unit-v1/unit-shape`], {
    ...publicUnit,
    'rv:disclosure': [`${vocabulary}Private`],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}content-private-match-unit-v1/unit-shape`], privateUnit))
    .toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}content-private-match-unit-v1/unit-shape`], {
    ...privateUnit,
    'rv:disclosure': [`${vocabulary}Public`],
  })).toBe(false);
});

test('name cleanup rejects a retired graph route field', () => {
  const shape = shapeSchemas[`${definition}name-registry-cleanup-v1/cleaned-shape`];
  expect(Value.Check(shape, { '@id': 'urn:content:retired-name' })).toBe(true);
  expect(Value.Check(shape, {
    '@id': 'urn:content:retired-name',
    'rv:routeSegment': ['old-name'],
  })).toBe(false);
});
