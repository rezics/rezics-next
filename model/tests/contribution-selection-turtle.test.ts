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
const ids = [
  'text-contribution-v1',
  'text-publication-v1',
  'main-default-selection-v1',
  'realm-local-selection-v1',
  'realm-local-rejection-v1',
  'realm-submission-selection-v1',
  'realm-policy-selection-v1',
] as const;

const originalPins = {
  'text-contribution-v1': '4a42b1851eaa3cace3e06c5a142329e7c3c380e756123c3b131dc2584c9d2d8b',
  'text-publication-v1': '831355eccb08af104d4dfc8d972cb4b8e4e4c39b40a3d83aab6a13f67af0dd37',
  'main-default-selection-v1': '92f91c7e990901a457bd688dd47f576178ffa1daa90f35a4d2d1c53f751de52a',
  'realm-local-selection-v1': '065cee2ee14324f92989a206e106a538a243621f3c54c55c9519cfcadf22def4',
  'realm-local-rejection-v1': '8db4a0124cf3b2ac61a28595fb05677e8dff8977c4b0a126740f583de6589e02',
  'realm-submission-selection-v1':
    '9bfc405a024d6db800620c6080cfc98cbae49cf027f57e41ca007337943c8996',
  'realm-policy-selection-v1': 'c695375f402934a868fc603ce59fb228640bf7d640000a6a3c5514693b57b472',
} as const;

const focusRoles = {
  'text-contribution-v1': ['contribution'],
  'text-publication-v1': ['decision'],
  'main-default-selection-v1': ['selection'],
  'realm-local-selection-v1': ['selection'],
  'realm-local-rejection-v1': ['rejection'],
  'realm-submission-selection-v1': ['selection', 'slot'],
  'realm-policy-selection-v1': ['selection'],
} as const;

const expectedCanonical = {
  'text-contribution-v1': [{ role: 'contribution', type: `${rv}TextContribution`, when: [] }],
  'text-publication-v1': [{ role: 'decision', type: `${rv}PublicationDecision`, when: [] }],
  'main-default-selection-v1': [
    {
      role: 'selection',
      type: `${rv}PublicationSelection`,
      when: [{ path: `${rv}selectionBasis`, value: `${rv}MainMaintainer` }],
    },
  ],
  'realm-local-selection-v1': [{ role: 'selection', type: `${rv}PublicationSelection`, when: [] }],
  'realm-local-rejection-v1': [
    { role: 'rejection', type: `${rv}RealmPublicationRejection`, when: [] },
  ],
  'realm-submission-selection-v1': [
    { role: 'selection', type: `${rv}RealmSubmissionSelection`, when: [] },
    { role: 'slot', type: `${rv}RealmResourceSlot`, when: [] },
  ],
  'realm-policy-selection-v1': [
    {
      role: 'selection',
      type: `${rv}PublicationSelection`,
      when: [{ path: `${rv}selectionBasis`, value: `${rv}RealmPolicy` }],
    },
  ],
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));
const iri = (name: string) => `urn:contribution-selection:${name}`;
const node = (name: string, type: string, properties: Record<string, string[]>) => ({
  '@id': iri(name),
  'rdf:type': [`${rv}${type}`],
  ...properties,
});
const selectionProperties = {
  'rv:context': [iri('context')],
  'rv:slot': [iri('slot')],
  'rv:work': [iri('work')],
  'rv:mainVersion': [iri('main-version')],
  'rv:contribution': [iri('contribution')],
  'rv:publicationDecision': [iri('decision')],
  'rv:selectedDraft': [iri('draft')],
};
const shape = (id: string, role: string) =>
  shapeSchemas[`${definition}${id}/${role}-shape` as keyof typeof shapeSchemas];

const sample = <T extends object>(
  id: string,
  role: string,
  valid: T,
  invalidName: string,
  changes: Record<string, unknown>,
) => ({ id, role, valid, invalid: { ...valid, '@id': iri(invalidName), ...changes } });
const missingSample = <T extends object>(
  id: string,
  role: string,
  valid: T,
  invalidName: string,
  property: string,
) => {
  const invalid: Record<string, unknown> = { ...valid, '@id': iri(invalidName) };
  delete invalid[property];
  return { id, role, valid, invalid };
};

const validationCases = [
  sample(
    'text-contribution-v1',
    'contribution',
    node('contribution', 'TextContribution', {
      'rv:work': [iri('work')],
      'rv:author': [iri('author')],
      'rv:language': ['en-US'],
      'rv:draftHead': [iri('draft')],
    }),
    'contribution-invalid-language',
    { 'rv:language': ['EN-us'] },
  ),
  sample(
    'text-publication-v1',
    'decision',
    node('decision', 'PublicationDecision', {
      'rv:contribution': [iri('contribution')],
      'rv:work': [iri('work')],
      'rv:author': [iri('author')],
      'rv:selectedDraft': [iri('draft')],
      'rv:rightsBasis': [`${rv}OriginalContribution`],
      'rv:disclosure': [`${rv}Public`],
    }),
    'decision-invalid-rights',
    { 'rv:rightsBasis': [`${rv}Other`] },
  ),
  sample(
    'main-default-selection-v1',
    'selection',
    node('main-selection', 'PublicationSelection', {
      'rv:context': [iri('context')],
      'rv:work': [iri('work')],
      'rv:mainVersion': [iri('main-version')],
      'rv:contribution': [iri('contribution')],
      'rv:publicationDecision': [iri('decision')],
      'rv:selectedDraft': [iri('draft')],
      'rv:selectionBasis': [`${rv}MainMaintainer`],
      'rv:selectionMode': [`${rv}Fixed`],
    }),
    'main-selection-invalid-basis',
    { 'rv:selectionBasis': [`${rv}RealmPolicy`] },
  ),
  sample(
    'realm-local-selection-v1',
    'selection',
    node('realm-selection', 'PublicationSelection', {
      ...selectionProperties,
      'rv:selectionBasis': [`${rv}RealmManagerReview`],
      'rv:selectionMode': [`${rv}Fixed`],
      'rv:reviewPolicy': [`${definition}realm-manager-reviewed-v1`],
    }),
    'realm-selection-invalid-basis',
    { 'rv:selectionBasis': [`${rv}RealmPolicy`] },
  ),
  sample(
    'realm-local-rejection-v1',
    'rejection',
    node('realm-rejection', 'RealmPublicationRejection', {
      'rv:context': [iri('context')],
      'rv:slot': [iri('slot')],
      'rv:work': [iri('work')],
      'rv:mainVersion': [iri('main-version')],
      'rv:decisionBasis': [`${rv}RealmManagerReview`],
      'rv:reasonCode': [`${rv}NotApproved`],
      'rv:selectionPolicy': [`${definition}realm-manager-fixed-main-fallback-v1`],
      'rv:reviewPolicy': [`${definition}realm-manager-reviewed-v1`],
      'rv:outcome': [`${rv}Rejected`],
    }),
    'realm-rejection-invalid-outcome',
    { 'rv:outcome': [`${rv}Approved`] },
  ),
  sample(
    'realm-submission-selection-v1',
    'selection',
    node('realm-submission', 'RealmSubmissionSelection', {
      'rv:component': [iri('component')],
      'rv:context': [iri('context')],
      'rv:work': [iri('work')],
      'rv:mainVersion': [iri('main-version')],
      'rv:workRevision': [iri('work-revision')],
      'rv:recordedBy': [iri('actor')],
      'rv:submittingAgent': [iri('agent')],
      'rv:manifest': [iri('manifest')],
      'rv:selectionMode': [`${rv}Following`],
      'rv:submissionKind': ['whole-work'],
      'rv:selectionBasis': [`${rv}RealmManagerReview`],
      'rv:dataEpoch': ['epoch-1'],
      'rv:sequence': [1],
    }),
    'realm-submission-invalid-mode',
    { 'rv:selectionMode': [`${rv}Immediate`] },
  ),
  missingSample(
    'realm-submission-selection-v1',
    'slot',
    node('realm-slot', 'RealmResourceSlot', {
      'rv:realm': [iri('realm')],
      'rv:work': [iri('work')],
      'rv:mainVersion': [iri('main-version')],
      'rv:selectionHead': [iri('selection')],
      'rv:submissionKind': ['whole-work'],
    }),
    'realm-slot-missing-head',
    'rv:selectionHead',
  ),
  missingSample(
    'realm-policy-selection-v1',
    'selection',
    node('policy-selection', 'PublicationSelection', {
      ...selectionProperties,
      'rv:selectionBasis': [`${rv}RealmPolicy`],
      'rv:selectionMode': [`${rv}Fixed`],
      'rv:reviewPolicy': [iri('review-policy')],
      'rv:realmPolicyHead': [iri('realm-policy-head')],
    }),
    'policy-selection-missing-head',
    'rv:realmPolicyHead',
  ),
] as const;

test('contribution and selection Turtle preserves source pins, focus routing, and command declarations', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const canonical = command.manifest.canonical as {
    type: string;
    routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
  }[];

  for (const id of ids) {
    const profile = profileById.get(id)!;
    const source = readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8');
    const record = published.get(id)!;
    const roles = focusRoles[id];

    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(digest(source)).toBe(originalPins[id]);
    expect(profileRegistry[id].sha256).toBe(originalPins[id]);
    expect(record.sha256).toBe(originalPins[id]);
    expect(record.focusRoles).toEqual(roles);
    expect(profile.shapes.map((item) => shapeRole(id, item.iri))).toEqual(roles);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
    expect(profile.binding).toBeUndefined();
    expect(
      (command.manifest.profiles as { id: string; binding?: unknown }[]).find(
        (item) => item.id === id,
      )?.binding,
    ).toBeUndefined();

    const routes = canonical
      .flatMap(({ type, routes: entries }) =>
        entries
          .filter((route) => route.profile === id)
          .map((route) => ({
            role: shapeRole(id, route.shape),
            type,
            when: route.when,
          })),
      )
      .sort((left, right) => left.role.localeCompare(right.role));
    expect(routes).toEqual(expectedCanonical[id]);
  }
  expect(
    (command.manifest.bindingDemands as { profile: string }[]).filter(({ profile }) =>
      ids.includes(profile as (typeof ids)[number]),
    ),
  ).toEqual([]);
});

test('contribution and selection shapes retain useful local acceptance and rejection cases', () => {
  for (const { id, role, valid, invalid } of validationCases) {
    const schema = shape(id, role);
    expect(Value.Check(schema, valid), `${id}/${role} accepts its valid example`).toBe(true);
    expect(Value.Check(schema, invalid), `${id}/${role} rejects its invalid example`).toBe(false);
  }
});
