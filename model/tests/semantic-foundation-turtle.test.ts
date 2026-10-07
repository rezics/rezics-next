import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const definition = 'https://rezics.com/definition/';
const converted = [
  'semantic-resource-v1',
  'semantic-model-generation-v1',
  'semantic-definition-v1',
  'semantic-rule-v1',
  'semantic-annotation-v1',
  'definition-presentation-v1',
  'value-exact-v1',
  'native-agent-credit-v1',
] as const;

const originalPins = {
  'semantic-resource-v1': '0ebbb7cd1f04b9adb75ecb0504013195561e38a8e59a398937b95e3c679bfd99',
  'semantic-model-generation-v1': '16d519183b325de019c55dc5ca2c5bf140b246ba4bb81609b16e386d431595f0',
  'semantic-definition-v1': 'c4755adab864370f58a4b27067ecd9aa6e4d4923ef97249364b4b34a76147e3e',
  'semantic-rule-v1': 'bf01a1cebd44c8ec698e408e49fe2bd08cb41aeccb8ffb88b2bf99fadbba29a2',
  'semantic-annotation-v1': 'd195472baf5db656b7086c576e95e0f17f057c95ebd766e3789bdecf033835a8',
  'definition-presentation-v1': 'e4aa036bbed4bb52762f8c0ec858120e86586d3d795cfd44fd21c6bd8fe6e3a7',
  'value-exact-v1': '839d218f826651e984ec804d15a856d40f9c08126e88cf2f67585656be83c2e4',
  'native-agent-credit-v1': '5e40e324be6ea9a9aa0503e265264685ee72d858060aeedb0701db93b7f96dea',
} as const;

const focusRoles = {
  'semantic-resource-v1': ['resource', 'revision'],
  'semantic-model-generation-v1': ['generation', 'head'],
  'semantic-definition-v1': ['definition', 'revision'],
  'semantic-rule-v1': ['slot', 'revision', 'dependency', 'dependency-page'],
  'semantic-annotation-v1': ['label', 'annotation', 'specific-resource', 'text-quote-selector'],
  'definition-presentation-v1': ['presentation', 'revision'],
  'value-exact-v1': ['quantity', 'temporal', 'directional-text', 'external-reference'],
  'native-agent-credit-v1': ['credit', 'revision'],
} as const;

const canonicalTypes = {
  'semantic-resource-v1': { resource: ['rdfs:Resource'], revision: ['rv:SemanticRevision'] },
  'semantic-model-generation-v1': { generation: ['rv:ModelGeneration'], head: ['rv:ModelComponent'] },
  'semantic-definition-v1': { definition: ['rv:SemanticDefinition'], revision: ['rv:DefinitionRevision'] },
  'semantic-rule-v1': {
    slot: ['rv:ContextRule'],
    revision: ['rv:FiniteRuleRevision'],
    dependency: ['rv:RuleDependency'],
    'dependency-page': ['rv:RuleDependencyPage'],
  },
  'semantic-annotation-v1': {},
  'definition-presentation-v1': {
    presentation: ['rv:DefinitionPresentation'],
    revision: ['rv:PresentationRevision'],
  },
  'value-exact-v1': {
    quantity: ['schema:QuantitativeValue'],
    temporal: ['time:GeneralDateTimeDescription'],
    'directional-text': ['rdf:CompoundLiteral'],
    'external-reference': ['rv:ExternalReference'],
  },
  'native-agent-credit-v1': {
    credit: ['rv:NativeAgentCredit'],
    revision: ['rv:NativeAgentCreditRevision'],
  },
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));

test('semantic foundation keeps its source pins, canonical focus roles, and presentation binding', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));

  for (const [id, pin] of Object.entries(originalPins)) {
    const profile = profileById.get(id)!;
    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id as keyof typeof profileRegistry].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(focusRoles[id as keyof typeof focusRoles]);
    expect(profile.shapes.map((shape) => shape.iri.split('/').at(-1)!.slice(0, -6))).toEqual(
      focusRoles[id as keyof typeof focusRoles],
    );
    expect(Object.fromEntries(profile.shapes.flatMap((shape) => shape.canonical
      ? [[shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical.types]]
      : []))).toEqual(canonicalTypes[id as keyof typeof canonicalTypes]);
  }

  for (const id of converted) {
    const profile = profileById.get(id)!;
    const source = readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8');
    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
  }

  const presentation = profileById.get('definition-presentation-v1')!;
  expect(presentation.binding).toEqual({
    required: ['presentation', 'revision', 'definition', 'meaningRevision', 'fromRole', 'toRole', 'language'],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:DefinitionPresentation', 'rv:PresentationRevision'],
  });
  expect((command.manifest.profiles as { id: string; binding?: unknown }[])
    .find((profile) => profile.id === 'definition-presentation-v1')?.binding).toEqual({
    optional: [],
    required: ['presentation', 'revision', 'definition', 'meaningRevision', 'fromRole', 'toRole', 'language'],
    roles: ['presentation', 'revision'],
  });
});

test('semantic resource and definition fixtures retain useful local validation', () => {
  const resource = {
    '@id': 'urn:semantic:resource:1',
    'rdf:type': ['http://www.w3.org/2000/01/rdf-schema#Resource'],
    'rv:semanticHead': ['urn:semantic:revision:1'],
  };
  const definitionNode = {
    '@id': 'urn:semantic:definition:1',
    'rdf:type': ['https://rezics.com/vocab/SemanticDefinition'],
    'rv:definitionKind': ['https://rezics.com/vocab/RelationDefinition'],
    'rv:definitionHead': ['urn:semantic:definition-revision:1'],
  };

  expect(Value.Check(shapeSchemas[`${definition}semantic-resource-v1/resource-shape`], resource)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}semantic-resource-v1/resource-shape`], {
    ...resource,
    'owl:sameAs': ['urn:semantic:other'],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}semantic-definition-v1/definition-shape`], definitionNode)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}semantic-definition-v1/definition-shape`], {
    ...definitionNode,
    'rv:definitionKind': ['https://rezics.com/vocab/UnadmittedDefinitionKind'],
  })).toBe(false);
});

test('semantic annotation and exact quantity fixtures preserve mixed IRI and literal values', () => {
  const annotation = {
    '@id': 'urn:semantic:annotation:1',
    'rdf:type': ['http://www.w3.org/ns/oa#Annotation'],
    'oa:hasTarget': ['urn:semantic:resource:1'],
    'oa:hasBody': ['urn:semantic:value:1', 'supporting note'],
    'oa:motivatedBy': ['http://www.w3.org/ns/oa#commenting'],
  };
  const quantity = {
    '@id': 'urn:semantic:quantity:1',
    'rdf:type': ['https://schema.org/QuantitativeValue'],
    'schema:value': ['12.50'],
    'schema:unitCode': ['urn:semantic:unit:meter'],
    'rv:lexicalForm': ['12.50'],
    'rv:uncertainty': ['urn:semantic:uncertainty:1'],
  };
  const annotationShape = shapeSchemas[`${definition}semantic-annotation-v1/annotation-shape`];
  const quantityShape = shapeSchemas[`${definition}value-exact-v1/quantity-shape`];

  expect(Value.Check(annotationShape, annotation)).toBe(true);
  expect(Value.Check(annotationShape, { ...annotation, 'oa:hasBody': 'supporting note' })).toBe(false);
  expect(Value.Check(quantityShape, quantity)).toBe(true);
  expect(Value.Check(quantityShape, { ...quantity, 'schema:value': ['12.50', '13.00'] })).toBe(false);
  expect(Value.Check(quantityShape, {
    ...quantity,
    'schema:value': ['urn:semantic:exact-value:1'],
    'rv:uncertainty': ['about 0.2'],
  })).toBe(true);
});
