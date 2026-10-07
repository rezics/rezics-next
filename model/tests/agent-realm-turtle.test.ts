import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs, expand } from '../compiler/outputs.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const vocab = (local: string) => rv + local;
const definitionIri = (id: string) => definition + id;
const shapeIri = (id: string, role: string) => definitionIri(id) + '/' + role + '-shape';
const ids = [
  'agent-profile-address-v1',
  'agent-profile-v1',
  'agent-profile-v2',
  'agent-provision-v1',
  'realm-public-profile-v1',
  'realm-public-profile-v2',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const outputs = buildModelOutputs(profiles);
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/agent-realm-turtle-'));
  temporary.push(path);
  return path;
}

const original = {
  'agent-profile-address-v1': {
    sha256: '4fafde7ef02e94ffff6bd3b961d4feeb206e30405843a42b376c605bbac21547',
    roles: ['profile', 'localized-profile', 'revision', 'localized-revision'],
  },
  'agent-profile-v1': {
    sha256: 'd91dccf08288f5c516f4d02de93c9b722869432d75b6d4bdeb6409003fb47c56',
    roles: ['profile'],
  },
  'agent-profile-v2': {
    sha256: 'c4b8bb40f451f742d13887220ac6ed3288a192301f4295097ac85a1f94fb5e27',
    roles: ['profile', 'revision', 'legacy-revision'],
  },
  'agent-provision-v1': {
    sha256: '39be9701579192f77c67c10996d9c66aa5daf0b1182fa0566c07064281038028',
    roles: ['agent', 'tombstone'],
  },
  'realm-public-profile-v1': {
    sha256: 'd03364027f8b706441ed9433b26360599f9b531f1a255bd1a49526d08f62ca24',
    roles: ['moderator-slot', 'revision', 'moderator-choice'],
  },
  'realm-public-profile-v2': {
    sha256: '2c5bdf0a1d434d2ddf5566a0ad56e8ea84290599a76e729837677d03c4f8b852',
    roles: ['revision'],
  },
} as const;

const expectedCanonical = {
  'agent-profile-address-v1': {
    profile: {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:PlainNameAddressV1' }],
    },
    'localized-profile': {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' }],
    },
    revision: {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/agent-profile-address-v1>' }],
    },
    'localized-revision': {
      types: ['rv:AgentPublicProfileRevision'],
      when: [
        { path: 'rv:modelRevision', value: '<https://rezics.com/definition/agent-profile-address-v1>' },
        { path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' },
      ],
    },
  },
  'agent-profile-v1': {},
  'agent-profile-v2': {
    profile: {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:LocalizedNameV2' }],
    },
    revision: {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/agent-profile-v2>' }],
    },
    'legacy-revision': {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/agent-profile-v1>' }],
    },
  },
  'agent-provision-v1': {
    agent: { types: ['rv:Agent'] },
    tombstone: { types: ['rv:AgentTombstone'] },
  },
  'realm-public-profile-v1': {
    'moderator-slot': { types: ['rv:RealmModeratorPublicChoice'] },
    revision: { types: ['rv:RealmPublicProfileRevision'] },
    'moderator-choice': { types: ['rv:RealmModeratorChoiceRevision'] },
  },
  'realm-public-profile-v2': {
    revision: {
      types: ['rv:RealmPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/realm-public-profile-v2>' }],
    },
  },
} as const;

let schemaPromise: Promise<Record<string, TSchema>> | undefined;
async function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  const schema = (await schemas())[shapeIri(id, role)]!;
  return Value.Check(schema, value);
}

const handle = 'agent-00000000-0000-4000-8000-000000000001';
const languageName = (value: string, language: string) => ({ '@value': value, '@language': language });

test('Agent and Realm Turtle profiles preserve exact pins, focus roles, canonical routes and declarations', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.every(isTurtleProfile)).toBe(true);

  const command = commandProfiles(authoredProfiles);
  const manifest = command.manifest as {
    profiles: { id: string; sha256: string; file: string; binding?: unknown }[];
    canonical: {
      type: string;
      routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
    }[];
    bindingDemands: { type: string; profile: string }[];
  };
  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    const published = manifest.profiles.find((entry) => entry.id === profile.id)!;
    expect(digest(profileSource(profile))).toBe(baseline.sha256);
    expect(published.sha256).toBe(baseline.sha256);
    expect(command.shapes.get(published.file)).toBe(profileSource(profile));
    const roles = profile.shapes.map((shape) => shape.iri.split('/').at(-1)!.slice(0, -6));
    expect(roles).toEqual(baseline.roles);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      baseline.roles.map((role) => shapeIri(profile.id, role)),
    );
    const canonical = Object.fromEntries(
      profile.shapes.flatMap((shape) => shape.canonical
        ? [[shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical]]
        : []),
    );
    expect(canonical).toEqual(expectedCanonical[profile.id as keyof typeof expectedCanonical]);
    expect(profile.binding).toBeUndefined();
    expect(published.binding).toBeUndefined();
  }
  expect(manifest.bindingDemands.filter((demand) => ids.includes(demand.profile))).toEqual([]);

  const selectedRoutes = manifest.canonical.flatMap((entry) =>
    entry.routes.filter((route) => ids.includes(route.profile)),
  ).map(({ profile, shape, when }) => ({ profile, shape, when }));
  const expectedRoutes = profiles.flatMap((profile) => profile.shapes.flatMap((shape) => {
    if (!shape.canonical) return [];
    const prefixes = new Map(profile.prefixes);
    return shape.canonical.types.map((type) => ({
      profile: profile.id,
      shape: shape.iri,
      when: (shape.canonical?.when ?? []).map((condition) => ({
        path: expand(condition.path, prefixes),
        value: expand(condition.value, prefixes),
      })),
    }));
  }));
  const sortRoutes = (routes: typeof expectedRoutes) =>
    [...routes].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  expect(selectedRoutes).toHaveLength(expectedRoutes.length);
  expect(sortRoutes(selectedRoutes)).toEqual(sortRoutes(expectedRoutes));
});

test('Agent and Realm profile values retain handle, localized-name, choice and payload bounds', async () => {
  const agentV1 = {
    '@id': 'urn:agent:test',
    'rdf:type': [vocab('Agent')],
    'rv:profileHandle': [handle],
    'rv:profileDisclosure': [vocab('Public')],
  };
  expect(await accepts('agent-profile-v1', 'profile', agentV1)).toBe(true);
  expect(await accepts('agent-profile-v1', 'profile', {
    ...agentV1, 'rv:profileHandle': ['not-an-agent-handle'],
  })).toBe(false);

  const agentV2 = {
    '@id': 'urn:agent:localized',
    'rdf:type': [vocab('Agent')],
    'rdfs:label': ['North Star'],
    'rv:profileHandle': [handle],
    'rv:profileDisclosure': [vocab('Public')],
    'rv:profileNameFormat': [vocab('LocalizedNameV2')],
    'rv:originalNameLanguage': ['en'],
    'rv:localizedName': [languageName('North Star', 'en'), languageName('Étoile Polaire', 'fr')],
  };
  expect(await accepts('agent-profile-v2', 'profile', agentV2)).toBe(true);
  expect(await accepts('agent-profile-v2', 'profile', {
    ...agentV2,
    'rv:localizedName': [languageName('North Star', 'en'), languageName('North Star FR', 'EN')],
  })).toBe(false);

  const provision = {
    '@id': 'urn:agent:provisioned',
    'rdf:type': [vocab('Agent')],
    'rv:agentKind': [vocab('PersonAgent')],
    'rdfs:label': ['Public author'],
  };
  expect(await accepts('agent-provision-v1', 'agent', provision)).toBe(true);
  expect(await accepts('agent-provision-v1', 'agent', {
    ...provision, 'rv:agentKind': [vocab('UnknownAgent')],
  })).toBe(false);

  const addressed = {
    '@id': 'urn:agent:addressed',
    'rdf:type': [vocab('Agent')],
    'rv:agentKind': [vocab('PersonAgent')],
    'rdfs:label': ['Public author'],
    'rv:profileStateFormat': [vocab('AddressedAgentProfileV1')],
    'rv:profileDisclosure': [vocab('Public')],
    'rv:profileNameFormat': [vocab('PlainNameAddressV1')],
  };
  expect(await accepts('agent-profile-address-v1', 'profile', addressed)).toBe(true);
  expect(await accepts('agent-profile-address-v1', 'profile', {
    ...addressed, 'rv:profileHandle': [handle],
  })).toBe(false);

  const localizedAddress = {
    ...addressed,
    'rv:profileNameFormat': [vocab('LocalizedNameAddressV1')],
    'rv:originalNameLanguage': ['en'],
    'rv:localizedName': [languageName('Public author', 'en')],
  };
  expect(await accepts('agent-profile-address-v1', 'localized-profile', localizedAddress)).toBe(true);
  expect(await accepts('agent-profile-address-v1', 'localized-profile', {
    ...localizedAddress, 'rv:localizedName': [],
  })).toBe(false);

  const realmChoice = {
    '@id': 'urn:realm:choice',
    'rdf:type': [vocab('RealmModeratorChoiceRevision'), vocab('RevisionAnchor')],
    'rv:component': ['urn:realm:public-choice'],
    'rv:operation': ['urn:operation:choice'],
    'rv:publicChoice': [vocab('Accepted')],
    'rv:modelRevision': [definitionIri('realm-public-profile-v1')],
    'rv:shapeRevision': [definitionIri('realm-public-profile-v1')],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  };
  expect(await accepts('realm-public-profile-v1', 'moderator-choice', realmChoice)).toBe(true);
  expect(await accepts('realm-public-profile-v1', 'moderator-choice', {
    ...realmChoice, 'rv:publicChoice': [vocab('Pending')],
  })).toBe(false);

  const realmV1 = {
    '@id': 'urn:realm:revision:v1',
    'rdf:type': [vocab('RealmPublicProfileRevision'), vocab('RevisionAnchor')],
    'rv:component': ['urn:realm:public'],
    'rv:operation': ['urn:operation:profile'],
    'rv:profilePayload': ['{}'],
    'rv:modelRevision': [definitionIri('realm-public-profile-v1')],
    'rv:shapeRevision': [definitionIri('realm-public-profile-v1')],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  };
  expect(await accepts('realm-public-profile-v1', 'revision', realmV1)).toBe(true);
  expect(await accepts('realm-public-profile-v1', 'revision', {
    ...realmV1, 'rv:profilePayload': ['x'],
  })).toBe(false);

  expect(await accepts('realm-public-profile-v2', 'revision', {
    ...realmV1,
    '@id': 'urn:realm:revision:v2',
    'rv:modelRevision': [definitionIri('realm-public-profile-v2')],
    'rv:shapeRevision': [definitionIri('realm-public-profile-v2')],
    'rv:profilePayload': ['{"name":"North"}'],
  })).toBe(true);
});
