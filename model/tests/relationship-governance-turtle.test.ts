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
const skos = 'http://www.w3.org/2004/02/skos/core#';
const ids = [
  'relation-occurrence-v1',
  'realm-reply-placement-v1',
  'space-zone-v1',
  'erasure-graph-v1',
  'statement-decision-v1',
  'classification-proposition-v2',
  'correction-proposal-v1',
  'correction-decision-v1',
  'event-time-v1',
] as const;

const originalPins = {
  'relation-occurrence-v1': '27269b50a2a7c632a6fa4a96bcc94d4e623f3b00e19b36926727c229bca099c6',
  'realm-reply-placement-v1': 'b939a1b25d6351a97f4ac0cf48240a0bf76a3f61b51e1ace558348fd382eb511',
  'space-zone-v1': 'dfe09fb0e4f2bc850e1f561f8f32dfdc3bf6f7070166c0b04fe8cd54ab273803',
  'erasure-graph-v1': '4f9da33919733b1cc31907564ad8dc4c77835db6c74edab99a9b175b20db8505',
  'statement-decision-v1': 'f5d5c72e0473c6abd0816c0cddceb6c70c8075a47a4d2eeb81b28f9e598b2490',
  'classification-proposition-v2': '22b3c0f677296e5c268514d0f87cb0dabdd2ae9900873e28b1540e27a87e01a6',
  'correction-proposal-v1': '9339a7d90b95ee5e93f40031bbd1564b60aff045081c590d579ff89f8e347fc5',
  'correction-decision-v1': '7bd209b0f518409342d5e0ed62ffb4afd17b10dec40ce06caf54bdd3432b358b',
  'event-time-v1': '99a65a3caed9f50d636b3112150a957172c87974b253248d212001449ae8a0ae',
} as const;

const focusRoles = {
  'relation-occurrence-v1': ['occurrence', 'participation', 'revision'],
  'realm-reply-placement-v1': ['slot', 'placement'],
  'space-zone-v1': ['space'],
  'erasure-graph-v1': ['tombstone'],
  'statement-decision-v1': ['slot', 'decision'],
  'classification-proposition-v2': ['scheme', 'concept', 'path', 'expression', 'sense'],
  'correction-proposal-v1': ['log', 'proposal'],
  'correction-decision-v1': ['decision', 'application'],
  'event-time-v1': ['event', 'slot', 'revision', 'point'],
} as const;

const route = (role: string, type: string, conditionProfile?: string) => ({
  role,
  type,
  when: conditionProfile
    ? [{
        path: `${vocabulary}definitionProfile`,
        value: `${definition}${conditionProfile}`,
      }]
    : [],
});

const canonicalRoutes = {
  'relation-occurrence-v1': [
    route('occurrence', `${vocabulary}RelationOccurrence`),
    route('participation', `${vocabulary}RelationParticipation`),
    route('revision', `${vocabulary}RelationOccurrenceRevision`),
  ],
  'realm-reply-placement-v1': [
    route('slot', `${vocabulary}RealmReplySlot`),
    route('placement', `${vocabulary}RealmReplyPlacement`),
  ],
  'space-zone-v1': [route('space', `${vocabulary}Space`, 'space-zone-v1')],
  'erasure-graph-v1': [],
  'statement-decision-v1': [
    route('slot', `${vocabulary}DecisionSlot`),
    route('decision', `${vocabulary}StatementDecision`),
  ],
  'classification-proposition-v2': [
    route('scheme', `${skos}ConceptScheme`, 'classification-proposition-v2'),
    route('concept', `${skos}Concept`, 'classification-proposition-v2'),
    route('path', `${vocabulary}ConceptPath`, 'classification-proposition-v2'),
    route('expression', `${vocabulary}ClassificationExpression`, 'classification-proposition-v2'),
    route('sense', `${vocabulary}ClassificationSense`, 'classification-proposition-v2'),
  ],
  'correction-proposal-v1': [
    route('log', `${vocabulary}CorrectionLog`),
    route('proposal', `${vocabulary}CorrectionProposal`),
  ],
  'correction-decision-v1': [
    route('decision', `${vocabulary}CorrectionDecision`),
    route('application', `${vocabulary}CorrectionApplication`),
  ],
  'event-time-v1': [
    route('event', `${vocabulary}Event`),
    route('slot', `${vocabulary}EventTime`),
  ],
} as const;

const alternatives = {
  'relation-occurrence-v1': {},
  'realm-reply-placement-v1': { placement: 2 },
  'space-zone-v1': {},
  'erasure-graph-v1': {},
  'statement-decision-v1': { slot: 2 },
  'classification-proposition-v2': {},
  'correction-proposal-v1': { proposal: 2 },
  'correction-decision-v1': { decision: 2 },
  'event-time-v1': { revision: 3, point: 3 },
} as const;

const bindings = {
  'realm-reply-placement-v1': {
    required: ['slot', 'placement', 'realm', 'reply', 'root', 'revision', 'review', 'author',
      'actor', 'receipt', 'scope', 'epoch'],
    roles: ['slot', 'placement'],
    demandedBy: ['rv:RealmReplyPlacement'],
  },
  'classification-proposition-v2': {
    required: ['scheme', 'concept', 'path', 'expression', 'sense'],
    roles: ['scheme', 'concept', 'path', 'expression', 'sense'],
    demandedBy: ['rv:VocabularyDefinition'],
  },
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const roleOf = (iri: string) => iri.split('/').at(-1)!.slice(0, -6);
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));

test('relationship and retained governance Turtle preserves original pins and registry metadata', () => {
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
      .map((entry) => ({ role: roleOf(entry.shape), type, when: entry.when })))
      .sort((a, b) => a.role.localeCompare(b.role));

    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(focusRoles[id]);
    expect(profile.shapes.map((shape) => roleOf(shape.iri))).toEqual(focusRoles[id]);
    expect(routes).toEqual([...canonicalRoutes[id]].sort((a, b) => a.role.localeCompare(b.role)));
    expect(Object.fromEntries(profile.shapes.flatMap((shape) => shape.or
      ? [[roleOf(shape.iri), shape.or.length]]
      : []))).toEqual(alternatives[id]);
    expect(profile.binding).toEqual(bindings[id as keyof typeof bindings]);
    expect(manifestProfiles.find((entry) => entry.id === id)?.binding).toEqual(
      id === 'realm-reply-placement-v1' || id === 'classification-proposition-v2'
        ? { optional: [], required: [...bindings[id as keyof typeof bindings]!.required],
          roles: [...bindings[id as keyof typeof bindings]!.roles] }
        : undefined,
    );
    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
  }
});

test('event time, statement targets and classification labels keep their local alternatives', () => {
  const eventRevision = {
    '@id': 'urn:event-time:revision',
    'rdf:type': [`${vocabulary}EventTimeRevision`],
    'rv:eventTime': ['urn:event-time:slot'],
    'rv:timeAvailability': [`${vocabulary}Withdrawn`],
    'rv:recordedAt': ['2026-03-30T00:00:00Z'],
  };
  const slot = {
    '@id': 'urn:decision:slot',
    'rdf:type': [`${vocabulary}DecisionSlot`],
    'rv:acceptanceContext': ['urn:classification:context'],
    'rv:decisionHead': ['urn:statement:decision'],
    'rv:targetKind': [`${vocabulary}StatementTarget`],
    'rv:decisionTarget': ['urn:rdf:statement'],
  };
  const concept = {
    '@id': 'urn:classification:concept',
    'rdf:type': [`${skos}Concept`],
    'rv:definitionProfile': [`${definition}classification-proposition-v2`],
    'skos:inScheme': ['urn:classification:scheme'],
    'skos:prefLabel': [
      { '@value': 'Example', '@language': 'en' },
      { '@value': 'Exemple', '@language': 'fr' },
    ],
    'rv:conceptState': [`${vocabulary}Active`],
    'rv:head': ['urn:classification:concept-revision'],
  };

  const eventShape = shapeSchemas[`${definition}event-time-v1/revision-shape`];
  const slotShape = shapeSchemas[`${definition}statement-decision-v1/slot-shape`];
  const conceptShape = shapeSchemas[`${definition}classification-proposition-v2/concept-shape`];
  expect(Value.Check(eventShape, eventRevision)).toBe(true);
  expect(Value.Check(eventShape, { ...eventRevision, 'rv:eventStart': ['urn:event-time:point'] })).toBe(false);
  expect(Value.Check(slotShape, slot)).toBe(true);
  expect(Value.Check(slotShape, {
    ...slot,
    'rv:targetKind': [`${vocabulary}QualifiedFactTarget`],
  })).toBe(true);
  expect(Value.Check(slotShape, { ...slot, 'rv:decisionTarget': [] })).toBe(false);
  expect(Value.Check(conceptShape, concept)).toBe(true);
  expect(Value.Check(conceptShape, {
    ...concept,
    'skos:prefLabel': [
      { '@value': 'Example', '@language': 'en' },
      { '@value': 'Exemple', '@language': 'EN' },
    ],
  })).toBe(false);
});

test('correction decisions require independence proof only for acceptance', () => {
  const operation = 'urn:operation:correction-decision';
  const base = {
    '@id': 'urn:correction:decision',
    'rdf:type': [`${vocabulary}CorrectionDecision`, `${vocabulary}RevisionAnchor`],
    'rv:proposalRevision': ['urn:correction:proposal-revision'],
    'rv:component': ['urn:work:one'],
    'rv:candidateDigest': ['a'.repeat(64)],
    'rv:ruleRevision': ['urn:rezics:protection-rule:independent-human-review-v1'],
    'rv:operation': [operation],
    'rv:decisionIntent': ['Independent decision'],
    'rv:manifest': ['urn:manifest:decision'],
    'rv:modelRevision': [`${definition}correction-decision-v1`],
    'rv:shapeRevision': [`${definition}correction-decision-v1`],
    'rv:dataEpoch': ['epoch'],
    'rv:sequence': [1],
  };
  const shape = shapeSchemas[`${definition}correction-decision-v1/decision-shape`];

  expect(Value.Check(shape, { ...base, 'rv:outcome': [`${vocabulary}Accepted`],
    'rv:independenceProof': ['urn:proof:independence'] })).toBe(true);
  expect(Value.Check(shape, { ...base, 'rv:outcome': [`${vocabulary}Accepted`] })).toBe(false);
  expect(Value.Check(shape, { ...base, 'rv:outcome': [`${vocabulary}Rejected`] })).toBe(true);
});
