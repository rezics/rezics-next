import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { authoredProfiles } from '../compiler/generate.ts';
import {
  buildCommandRegistry, commandBindingGraphs, commandBindingRead, selectCommandProfile,
} from '../compiler/registry.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const oldRoles = ['author', 'translator', 'editor', 'director', 'artist', 'animation-studio'];
const families = ['native-agent-credit', 'work-author-credit'] as const;
type Family = typeof families[number];
type Version = 1 | 2;
type Role = 'credit' | 'revision';
const registry = buildCommandRegistry(authoredProfiles);

function node(family: Family, version: Version, focus: Role, role: string) {
  const native = family === 'native-agent-credit';
  const profile = `${definition}${family}-v${version}`;
  const common = {
    'rv:work': ['urn:work:credited'], 'schema:roleName': [role],
    ...(native ? { 'rv:agent': ['urn:agent:credited'] } : {
      'rv:externalProvider': ['open-library'], 'rv:externalNamespace': ['author'],
      'rv:externalKey': ['/authors/OL1A'], 'schema:position': [0],
      'rv:editControl': [`${rv}HumanConfirmed`], 'rv:rightsStatus': [`${rv}Undetermined`],
    }),
  };
  return focus === 'credit' ? {
    '@id': 'urn:credit:repeated:1',
    'rdf:type': [`${rv}${native ? 'NativeAgentCredit' : 'AuthorCredit'}`],
    'rv:creditRevision': ['urn:credit:revision:1'],
    ...(version === 2 ? { 'rv:modelRevision': [profile] } : {}), ...common,
  } : {
    '@id': 'urn:credit:revision:1',
    'rdf:type': native ? [`${rv}NativeAgentCreditRevision`]
      : [`${rv}AuthorCreditRevision`, `${rv}RevisionAnchor`],
    'rv:component': ['urn:credit:repeated:1'], 'rv:workRevision': ['urn:work:head'],
    ...(!native ? {
      'rv:confirmedBy': ['urn:agent:maintainer'],
      'rv:dataEpoch': ['00000000-0000-4000-8000-000000000001'], 'rv:sequence': [1],
    } : {}),
    ...(!native || version === 2 ? {
      'rv:modelRevision': [profile], 'rv:shapeRevision': [profile],
    } : {}), ...common,
  };
}

function accepts(family: Family, version: Version, focus: Role, value: unknown) {
  const iri = `${definition}${family}-v${version}/${focus}-shape` as keyof typeof shapeSchemas;
  return Value.Check(shapeSchemas[iri], value);
}

test('Performer has an explicit successor profile while both original credit profiles keep their pins and routing', () => {
  const pins = {
    'native-agent-credit-v1': '307be7d1ac523958e6b5e9c83210288214ce2bf53a2046202b8c2f7e35d3c0de',
    'work-author-credit-v1': 'c24cb44e45b1b096f5a26862e4fe6ecd1aa862db2af26c33f1a6cb624bf1e732',
  } as const;
  for (const [id, pin] of Object.entries(pins)) {
    expect(createHash('sha256').update(readFileSync(`${import.meta.dir}/../definitions/${id}.ttl`)).digest('hex')).toBe(pin);
    expect(profileRegistry[id as keyof typeof profileRegistry].sha256).toBe(pin);
  }
  for (const family of families) for (const focus of ['credit', 'revision'] as const) {
    const type = `${rv}${family === 'native-agent-credit' ? 'NativeAgentCredit' : 'AuthorCredit'}${focus === 'revision' ? 'Revision' : ''}`;
    const selected = (values: readonly string[]) => selectCommandProfile(registry, [type], () => values);
    expect(selected([])?.profile).toBe(`${family}-v1`);
    expect(selected([`${definition}${family}-v1`])?.profile).toBe(`${family}-v1`);
    expect(selected([`${definition}${family}-v2`])?.profile).toBe(`${family}-v2`);
    expect(selected([`${definition}${family}-v2`])?.shape).toBe(`${definition}${family}-v2/${focus}-shape`);
  }
});

test('only the explicit V2 credit and revision shapes admit Performer without reinterpreting any original role', () => {
  for (const family of families) for (const focus of ['credit', 'revision'] as const) {
    for (const role of oldRoles) for (const version of [1, 2] as const) {
      expect(accepts(family, version, focus, node(family, version, focus, role))).toBe(true);
    }
    expect(accepts(family, 1, focus, node(family, 1, focus, 'performer'))).toBe(false);
    const performer = node(family, 2, focus, 'performer');
    expect(accepts(family, 2, focus, performer)).toBe(true);
    const withoutPin = { ...performer, 'rv:modelRevision': [] };
    expect(accepts(family, 2, focus, withoutPin)).toBe(false);
    expect(accepts(family, 2, focus, { ...performer, 'rv:modelRevision': [`${definition}${family}-v1`] })).toBe(false);
    if (focus === 'revision') {
      expect(accepts(family, 2, focus, { ...performer, 'rv:shapeRevision': [`${definition}${family}-v1`] })).toBe(false);
    }
    for (const role of ['voice-actor', 'transcriber', 'vocal', 'lead']) {
      expect(accepts(family, 2, focus, node(family, 2, focus, role))).toBe(false);
    }
  }
});

test('external Performer credit preserves source-key identity, ordinal and the prohibition on native Agent inference', () => {
  for (const focus of ['credit', 'revision'] as const) {
    const value = node('work-author-credit', 2, focus, 'performer');
    expect(accepts('work-author-credit', 2, focus, { ...value, 'rv:agent': ['urn:agent:inferred'] })).toBe(false);
    expect(accepts('work-author-credit', 2, focus, { ...value, 'schema:author': ['urn:agent:inferred'] })).toBe(false);
    expect(accepts('work-author-credit', 2, focus, { ...value, 'rv:externalKey': [] })).toBe(false);
    expect(accepts('work-author-credit', 2, focus, { ...value, 'schema:position': [128] })).toBe(false);
    expect(accepts('work-author-credit', 2, focus, { ...value, 'rv:editControl': [`${rv}Automatic`] })).toBe(false);
  }
});

test('external credit successor retains the exact Work-edit binding and actual receipt graphs', () => {
  const binding = registry.bindings.get('work-author-credit-v2')!;
  expect(binding).toEqual(registry.bindings.get('work-author-credit-v1'));
  // One existing type demand remains; native canonical selection requires the
  // selected successor binding rather than making another type-level authority.
  expect(registry.bindingDemands.filter(({ type }) => type === `${rv}AuthorCredit` || type === `${rv}AuthorCreditRevision`))
    .toEqual([
      { type: `${rv}AuthorCredit`, profile: 'work-author-credit-v1' },
      { type: `${rv}AuthorCreditRevision`, profile: 'work-author-credit-v1' },
    ]);
  const graphs = { current: 'urn:graph:current', revisions: 'urn:graph:revisions', receipts: 'urn:graph:receipts', control: 'urn:graph:control' };
  expect(commandBindingGraphs('work-author-credit-v2', graphs)).toEqual(Object.values(graphs));
  const read = commandBindingRead('work-author-credit-v2', binding,
    `${definition}work-author-credit-v2/credit-shape`, Object.values(graphs), registry);
  expect(read.pattern).toContain('sourceIntent');
  expect(read.pattern).toContain('creditRevision');
  expect(read.pattern).toContain('workRevision');
  expect(read.keys).toContain('receipt');
  expect(read.keys).toContain('work-head');
});
