import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { profileSource } from '../compiler/shacl.ts';
import { agentErasureProfile } from '../definitions/agent-erasure-v1.ts';
import { agentProvisionProfile } from '../definitions/agent-provision-v1.ts';

const rv = 'https://rezics.com/vocab/';
const shape = 'https://rezics.com/definition/agent-erasure-v1/tombstone-shape';
const temporaryRoot = resolve(import.meta.dir, '../../.temp');
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, 'agent-erasure-model-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const path = join(temporary, 'schemas.ts');
writeFileSync(path, buildModelOutputs([agentErasureProfile]).get('packages/model/src/generated/schemas.ts')!);
const { shapeSchemas } = await import(path) as { shapeSchemas: Record<string, TSchema> };
const accepts = (value: Record<string, unknown>) => Value.Check(shapeSchemas[shape]!, value);
const tombstone = () => ({
  '@id': 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  'rdf:type': [`${rv}AgentTombstone`],
  'rv:agentKind': [`${rv}PersonAgent`],
  'rv:erasureId': ['00000000-0000-4000-8000-000000000002'],
  'rv:erasureEpoch': [7],
});

test('authored Person tombstone is discovered and carried unchanged in the native manifest', () => {
  expect(authoredProfiles.some(profile => profile.id === agentErasureProfile.id)).toBe(true);
  const native = commandProfiles([agentErasureProfile, agentProvisionProfile]);
  expect(native.shapes.get('shapes/agent-erasure-v1.ttl')).toBe(profileSource(agentErasureProfile));
  const registry = buildCommandRegistry([agentErasureProfile, agentProvisionProfile]);
  const route = registry.canonical.find(entry => entry.type === `${rv}AgentTombstone`)!;
  expect(route.routes.map(entry => entry.profile)).toEqual(['agent-erasure-v1', 'agent-provision-v1']);
  expect(route.routes[0]!.when).toEqual([{ path: `${rv}agentKind`, value: `${rv}PersonAgent` }]);
  expect(accepts(tombstone())).toBe(true);
});

test('erasure requires one exact journal identity, positive epoch and retained Person kind', () => {
  for (const key of ['rdf:type', 'rv:agentKind', 'rv:erasureId', 'rv:erasureEpoch']) {
    const missing: Record<string, unknown> = tombstone();
    delete missing[key];
    expect(accepts(missing)).toBe(false);
  }
  for (const type of ['Agent', 'RevisionAnchor', 'ErasedRevision']) {
    expect(accepts({ ...tombstone(), 'rdf:type': [`${rv}${type}`] })).toBe(false);
  }
  expect(accepts({ ...tombstone(), 'rdf:type': [`${rv}AgentTombstone`, `${rv}Agent`] })).toBe(false);
  for (const kind of ['OrganizationAgent', 'ServiceAgent']) {
    expect(accepts({ ...tombstone(), 'rv:agentKind': [`${rv}${kind}`] })).toBe(false);
  }
  for (const id of ['', 'ACCOUNT-IDENTITY', 'urn:rezics:erasure:00000000-0000-4000-8000-000000000002']) {
    expect(accepts({ ...tombstone(), 'rv:erasureId': [id] })).toBe(false);
  }
  expect(accepts({ ...tombstone(), 'rv:erasureId': [...tombstone()['rv:erasureId'], '00000000-0000-4000-8000-000000000003'] })).toBe(false);
  for (const epoch of [0, -1, 1.5, '7']) {
    expect(accepts({ ...tombstone(), 'rv:erasureEpoch': [epoch] })).toBe(false);
  }
  expect(accepts({ ...tombstone(), 'rv:erasureEpoch': [7, 8] })).toBe(false);
});

test('closed tombstone refuses every identifying profile field and compensation proof', () => {
  for (const predicate of [
    'rdfs:label', 'schema:name', 'schema:alternateName', 'skos:prefLabel', 'skos:altLabel',
    'rv:localizedName', 'rv:originalNameLanguage', 'rv:profileBio', 'rv:profileAvatarSelection',
    'rv:profileHandle', 'rv:publicProfileHead', 'rv:head', 'rv:profileNameFormat',
    'rv:profileStateFormat', 'rv:profileDisclosure', 'rv:compensatedFrom', 'rv:unreviewedProfileField',
  ]) {
    expect(accepts({ ...tombstone(), [predicate]: ['retained-profile-copy'] })).toBe(false);
  }
  // Compensation must never satisfy an Account-deletion tombstone by inventing
  // a journal identity or reusing the provisioning compensation shape.
  expect(accepts({
    '@id': tombstone()['@id'],
    'rdf:type': [`${rv}AgentTombstone`],
    'rv:compensatedFrom': ['urn:rezics:receipt:agent-provision:opaque'],
  })).toBe(false);
});
