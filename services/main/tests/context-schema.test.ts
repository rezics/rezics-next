import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../src/modules/classification/context.ts';
import { CONTEXT_LIMITS, GLOBAL_SEMANTIC_CONTEXT, InvalidContextSchemaInput, canonicalContextEntries,
  contextEntryIri, contextSelectionCandidates, contextSelectionKey, contextSelectionScopeKey,
  nextInheritanceDepth, type ContextEntryRecord } from '../src/modules/context/schema.ts';
import { privateSelectionLookupKeys } from '../src/modules/context/private-selection-schema.ts';
import { InvalidStatementSchemaInput, convertV1ClassificationSlot, decisionSlotIri, resolveAcceptance,
  statementMeaningKey, type SlotReading, type StatementMeaning } from '../src/modules/statement/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const RV = 'https://rezics.com/vocab/';
const id = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const directory = join(root, '.temp', `context-schema-${Bun.randomUUIDv7()}`);
interface Profile { id: string; shapes: readonly { iri: string }[] }
// model/ has no tsconfig of its own; computed imports keep it outside Main's typecheck program.
const load = async <T>(path: string): Promise<T> => await import(join(root, path)) as T;
let profiles: Profile[] = [];
let renderProfile: (profile: Profile) => string;
let shapes: Record<string, unknown> = {};

beforeAll(async () => {
  const modules = await Promise.all(['context-v1', 'context-selection-v1', 'statement-v1', 'statement-decision-v1']
    .map(name => load<Record<string, Profile>>(`model/definitions/${name}.ts`)));
  profiles = modules.map(module => Object.entries(module).find(([name]) => name.endsWith('Profile'))![1]);
  ({ renderProfile } = await load<{ renderProfile: typeof renderProfile }>('model/compiler/ir.ts'));
  const { buildModelOutputs } = await load<{ buildModelOutputs: (profiles: Profile[]) => Map<string, string> }>(
    'model/compiler/outputs.ts');
  // Compile the authored profiles in memory; committed generated files are regenerated per wave.
  mkdirSync(directory, { recursive: true });
  const outputs = buildModelOutputs(profiles);
  writeFileSync(join(directory, 'schemas.ts'), outputs.get('packages/model/src/generated/schemas.ts')!);
  shapes = (await import(join(directory, 'schemas.ts')) as { shapeSchemas: Record<string, unknown> }).shapeSchemas;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const check = (profile: string, shape: string, candidate: unknown) => {
  const schema = shapes[`https://rezics.com/definition/${profile}/${shape}-shape`];
  if (!schema) throw new Error(`missing ${profile}/${shape}`);
  return Value.Check(schema as never, candidate);
};
const anchor = (profile: string) => ({ 'rv:operation': [id()], 'rv:manifest': [`urn:rezics:sha256:${'a'.repeat(64)}`],
  'rv:modelRevision': [`https://rezics.com/definition/${profile}`],
  'rv:shapeRevision': [`https://rezics.com/definition/${profile}`], 'rv:dataEpoch': ['epoch'], 'rv:sequence': [1] });

test('MODEL13 schema foundation: profiles render and reuse rdf:Statement without a local Statement class', () => {
  for (const profile of profiles) expect(renderProfile(profile)).toContain(`<https://rezics.com/definition/${profile.id}/`);
  const statement = renderProfile(profiles[2]!);
  expect(statement).toContain('sh:path rdf:type ; sh:hasValue rdf:Statement');
  expect(statement).not.toContain('rv:Statement ');
  expect(profiles.map(profile => profile.shapes.map(shape => shape.iri.split('/').at(-1)))).toEqual([
    ['global-shape', 'context-shape', 'semantic-revision-shape', 'entry-shape', 'preference-revision-shape'],
    ['selection-shape', 'revision-shape'], ['statement-shape', 'revision-shape'],
    ['slot-shape', 'decision-shape']]);
  const meaningKey = `urn:rezics:meaning:${'b'.repeat(64)}`;
  const valid = { '@id': id(), 'rdf:type': [`${'http://www.w3.org/1999/02/22-rdf-syntax-ns#'}Statement`],
    'rdf:subject': [id()], 'rdf:predicate': [`${RV}classifiedAs`], 'rdf:object': [{ '@value': 'red' }],
    'rv:relationDefinition': [id()], 'rv:speaker': [id()], 'rv:meaningKey': [meaningKey],
    'rv:statementState': [`${RV}Active`], 'rv:head': [id()] };
  expect(check('statement-v1', 'statement', valid)).toBe(true);
  expect(check('statement-v1', 'statement', { ...valid, 'rv:principal': [id()] })).toBe(false);
  expect(check('statement-v1', 'statement', { ...valid, 'rv:interpretationDefinition':
    Array.from({ length: 9 }, id) })).toBe(false);
  const { 'rv:meaningKey': _, ...keyless } = valid;
  expect(check('statement-v1', 'statement', keyless)).toBe(false);
  expect(check('statement-v1', 'revision', { '@id': id(), 'rdf:type': [`${RV}StatementRevision`, `${RV}RevisionAnchor`],
    'rv:component': [valid['@id']], 'rv:statementState': [`${RV}Withdrawn`], 'rv:recordedBy': [id()],
    ...anchor('statement-v1') })).toBe(true);
});

test('CTX01 schema foundation: Context headers have no Realm parent or principal and keep independent heads', () => {
  const global = { '@id': GLOBAL_SEMANTIC_CONTEXT, 'rdf:type': [`${RV}SemanticContext`],
    'rv:contextRole': [`${RV}GlobalInterpretation`], 'rv:contextState': [`${RV}Active`],
    'rv:disclosure': [`${RV}Public`], 'rv:semanticHead': [id()] };
  expect(check('context-v1', 'global', global)).toBe(true);
  expect(check('context-v1', 'global', { ...global, 'rv:disclosure': [`${RV}Private`] })).toBe(false);
  expect(check('context-v1', 'global', { ...global, 'rv:realm': [id()] })).toBe(false);
  const shared = { ...global, '@id': id(), 'rv:contextRole': [`${RV}SharedInterpretation`],
    'rv:disclosure': [`${RV}Private`], 'rv:preferenceHead': [id()] };
  expect(check('context-v1', 'context', shared)).toBe(true);
  expect(check('context-v1', 'context', { ...shared, 'rv:contextState': [`${RV}Retired`] })).toBe(true);
  expect(check('context-v1', 'context', { ...shared, 'rv:principal': [id()] })).toBe(false);
  expect(check('context-v1', 'context', { ...shared, 'rv:semanticHead': [id(), id()] })).toBe(false);
  const semantic = { '@id': id(), 'rdf:type': [`${RV}ContextSemanticRevision`, `${RV}RevisionAnchor`],
    'rv:component': [shared['@id']], 'rv:inheritanceDepth': [1], 'rv:entryCount': [1],
    'rv:entry': [contextEntryIri({ target: id(), relation: null, state: 'unresolved', definition: null,
      applicability: [] })], 'rv:baseRevision': [id()], 'rv:authoredBy': [id()], ...anchor('context-v1') };
  expect(check('context-v1', 'semantic-revision', semantic)).toBe(true);
  expect(check('context-v1', 'semantic-revision', { ...semantic, 'rv:inheritanceDepth': [9] })).toBe(false);
  expect(check('context-v1', 'semantic-revision', { ...semantic, 'rv:entryCount': [257] })).toBe(false);
  const preference = { '@id': id(), 'rdf:type': [`${RV}ContextPreferenceRevision`, `${RV}RevisionAnchor`],
    'rv:component': [shared['@id']], 'rv:preferenceCount': [3], 'rv:authoredBy': [id()], ...anchor('context-v1') };
  expect(check('context-v1', 'preference-revision', preference)).toBe(true);
  expect(check('context-v1', 'preference-revision', { ...preference, 'rv:baseRevision': [id()] })).toBe(false);
  expect(check('context-v1', 'preference-revision', { ...preference, 'rv:entry': semantic['rv:entry'] })).toBe(false);
});

test('CTX03: schema foundation unresolved and disabled entries are explicit, never absent definitions', () => {
  const entry = { '@id': 'urn:rezics:context-entry:x', 'rdf:type': [`${RV}ContextEntry`], 'rv:entryTarget': [id()] };
  expect(check('context-v1', 'entry', { ...entry, 'rv:entryState': [`${RV}Defined`],
    'rv:interpretationDefinition': [id()] })).toBe(true);
  expect(check('context-v1', 'entry', { ...entry, 'rv:entryState': [`${RV}Defined`] })).toBe(false);
  expect(check('context-v1', 'entry', { ...entry, 'rv:entryState': [`${RV}Unresolved`] })).toBe(true);
  expect(check('context-v1', 'entry', { ...entry, 'rv:entryState': [`${RV}Disabled`],
    'rv:interpretationDefinition': [id()] })).toBe(false);
  expect(check('context-v1', 'entry', entry)).toBe(false);

  const target = id();
  const definedA: ContextEntryRecord = { target, relation: null, state: 'defined', definition: id(), applicability: [] };
  expect(contextEntryIri(definedA)).toBe(contextEntryIri({ ...definedA }));
  expect(contextEntryIri(definedA)).not.toBe(contextEntryIri({ ...definedA, definition: id() }));
  expect(contextEntryIri({ ...definedA, state: 'unresolved', definition: null }))
    .not.toBe(contextEntryIri({ ...definedA, state: 'disabled', definition: null }));
  expect(() => contextEntryIri({ ...definedA, definition: null })).toThrow(InvalidContextSchemaInput);
  expect(() => contextEntryIri({ ...definedA, state: 'unresolved' })).toThrow(InvalidContextSchemaInput);
  expect(() => canonicalContextEntries([definedA, { ...definedA, definition: id() }]))
    .toThrow('duplicate Context entry slot');
  expect(canonicalContextEntries([definedA, { ...definedA, relation: `${RV}genre` }])).toHaveLength(2);
  expect(() => canonicalContextEntries(Array.from({ length: CONTEXT_LIMITS.entries + 1 },
    () => ({ ...definedA, target: id() })))).toThrow('too many Context entries');
  expect(nextInheritanceDepth(null)).toBe(0);
  expect(nextInheritanceDepth(CONTEXT_LIMITS.inheritanceDepth - 1)).toBe(CONTEXT_LIMITS.inheritanceDepth);
  expect(() => nextInheritanceDepth(CONTEXT_LIMITS.inheritanceDepth)).toThrow(InvalidContextSchemaInput);
});

test('CTX06 schema foundation: selection scopes have fixed precedence, equal-priority domains and bounds', () => {
  const object = id();
  const [domainB, domainA] = [id(), id()].sort().reverse() as [string, string];
  const candidates = contextSelectionCandidates(object, `${RV}genre`, [domainB, domainA]);
  expect(candidates.map(level => level.map(scope => scope.kind))).toEqual([
    ['object-relation'], ['object'], ['domain', 'domain'], ['default']]);
  expect(candidates[2]!.map(scope => scope.kind === 'domain' && scope.domain)).toEqual([domainA, domainB]);
  expect(contextSelectionCandidates(object, null, []).map(level => level[0]!.kind)).toEqual(['object', 'default']);
  expect(() => contextSelectionCandidates(object, null, Array.from({ length: 9 }, id))).toThrow(InvalidContextSchemaInput);
  expect(() => contextSelectionCandidates(object, null, [domainA, domainA])).toThrow(InvalidContextSchemaInput);
  const keys = privateSelectionLookupKeys(contextSelectionCandidates(object, `${RV}genre`,
    Array.from({ length: CONTEXT_LIMITS.domainCandidates }, id)).flat());
  expect(keys).toHaveLength(CONTEXT_LIMITS.scopeCandidates);
  expect(contextSelectionScopeKey({ kind: 'object-relation', object, relation: `${RV}genre` }))
    .toBe(`object-relation|${object}|${RV}genre|`);

  const selection = { '@id': id(), 'rdf:type': [`${RV}ContextSelection`], 'rv:consumer': [id()],
    'rv:selectionRole': [`${RV}SpeakerSelection`],
    'rv:scopeProfile': ['https://rezics.com/definition/context-selection-scope-v1'],
    'rv:selectionKey': [contextSelectionKey(id(), 'speaker', { kind: 'default' })],
    'rv:contextSelectionHead': [id()] };
  expect(check('context-selection-v1', 'selection', { ...selection, 'rv:scopeKind': [`${RV}DefaultScope`] })).toBe(true);
  expect(check('context-selection-v1', 'selection', { ...selection, 'rv:scopeKind': [`${RV}DefaultScope`],
    'rv:scopeObject': [object] })).toBe(false);
  expect(check('context-selection-v1', 'selection', { ...selection, 'rv:scopeKind': [`${RV}ObjectRelationScope`],
    'rv:scopeObject': [object] })).toBe(false);
  expect(check('context-selection-v1', 'selection', { ...selection, 'rv:scopeKind': [`${RV}DomainScope`],
    'rv:scopeDomain': [domainA] })).toBe(true);
  expect(check('context-selection-v1', 'selection', { ...selection, 'rv:scopeKind': [`${RV}ObjectScope`],
    'rv:scopeObject': [object], 'rv:principal': [id()] })).toBe(false);
  const revision = { '@id': id(), 'rdf:type': [`${RV}ContextSelectionRevision`, `${RV}RevisionAnchor`],
    'rv:component': [selection['@id']], 'rv:selectedBy': [id()], ...anchor('context-selection-v1') };
  expect(check('context-selection-v1', 'revision', { ...revision, 'rv:selectionState': [`${RV}Selected`],
    'rv:context': [id()], 'rv:semanticRevision': [id()] })).toBe(true);
  expect(check('context-selection-v1', 'revision', { ...revision, 'rv:selectionState': [`${RV}Selected`],
    'rv:context': [id()] })).toBe(false);
  expect(check('context-selection-v1', 'revision', { ...revision, 'rv:selectionState': [`${RV}Cleared`] })).toBe(true);
  expect(check('context-selection-v1', 'revision', { ...revision, 'rv:selectionState': [`${RV}Cleared`],
    'rv:preferenceRevision': [id()] })).toBe(false);
  const consumer = id();
  expect(contextSelectionKey(consumer, 'speaker', { kind: 'object', object }))
    .toBe(contextSelectionKey(consumer, 'speaker', { kind: 'object', object }));
  expect(contextSelectionKey(consumer, 'speaker', { kind: 'object', object }))
    .not.toBe(contextSelectionKey(consumer, 'entry-default', { kind: 'object', object }));
});

test('CTX05 schema foundation: meaning keys follow exact definitions, not labels, speakers or Contexts', () => {
  const [character, red, hairColor, eyeColor, redHair] = [id(), id(), id(), id(), id()];
  const base: StatementMeaning = { subject: character, predicate: `${RV}hairColor`, relationDefinition: hairColor,
    interpretationDefinitions: [], value: { kind: 'resource', iri: red }, applicability: [] };
  const hair = statementMeaningKey(base);
  expect(hair).toMatch(/^urn:rezics:meaning:[0-9a-f]{64}$/);
  expect(statementMeaningKey({ ...base, predicate: `${RV}eyeColor`, relationDefinition: eyeColor })).not.toBe(hair);
  expect(statementMeaningKey({ ...base, predicate: `${RV}classifiedAs`, relationDefinition: id() })).not.toBe(hair);
  expect(statementMeaningKey({ ...base, value: { kind: 'resource', iri: redHair } })).not.toBe(hair);
  const [globalHarem, realmHarem] = [id(), id()];
  const harem = { ...base, interpretationDefinitions: [globalHarem] };
  expect(statementMeaningKey(harem)).not.toBe(statementMeaningKey({ ...base, interpretationDefinitions: [realmHarem] }));
  expect(statementMeaningKey({ ...base, interpretationDefinitions: [realmHarem, globalHarem] }))
    .toBe(statementMeaningKey({ ...base, interpretationDefinitions: [globalHarem, realmHarem] }));
  expect(statementMeaningKey({ ...base, applicability: [id()] })).not.toBe(hair);
  expect(statementMeaningKey({ ...base, value: { kind: 'no-value' } }))
    .not.toBe(statementMeaningKey({ ...base, value: { kind: 'some-value' } }));
  expect(() => statementMeaningKey({ ...base, interpretationDefinitions: [globalHarem, globalHarem] }))
    .toThrow(InvalidStatementSchemaInput);
  const statement = id();
  const realmContext = id();
  expect(decisionSlotIri({ kind: 'statement', statement }, realmContext))
    .not.toBe(decisionSlotIri({ kind: 'statement', statement }, GLOBAL_CLASSIFICATION_CONTEXT));
  expect(decisionSlotIri({ kind: 'qualified-fact', meaningKey: hair }, realmContext))
    .not.toBe(decisionSlotIri({ kind: 'statement', statement }, realmContext));
  expect(() => decisionSlotIri({ kind: 'qualified-fact', meaningKey: statement }, realmContext))
    .toThrow(InvalidStatementSchemaInput);
  expect(check('statement-decision-v1', 'slot', { '@id': decisionSlotIri({ kind: 'qualified-fact', meaningKey: hair },
    realmContext), 'rdf:type': [`${RV}DecisionSlot`], 'rv:acceptanceContext': [realmContext],
  'rv:decisionHead': [id()], 'rv:targetKind': [`${RV}QualifiedFactTarget`], 'rv:decisionTarget': [hair] })).toBe(true);
  expect(check('statement-decision-v1', 'slot', { '@id': 'urn:rezics:decision-slot:x', 'rdf:type': [`${RV}DecisionSlot`],
    'rv:acceptanceContext': [realmContext], 'rv:decisionHead': [id()], 'rv:decisionTarget': [hair] })).toBe(false);
});

test('CTX02: schema foundation local rejection suppresses, absence may inherit, unavailable never falls back', () => {
  const accepted: SlotReading = { state: 'decided', slot: 'urn:g', decision: 'urn:gd', outcome: 'accepted' };
  const rejected: SlotReading = { state: 'decided', slot: 'urn:l', decision: 'urn:ld', outcome: 'rejected' };
  const withdrawn: SlotReading = { state: 'decided', slot: 'urn:l', decision: 'urn:lw', outcome: 'withdrawn' };
  const inherit = CLASSIFICATION_INHERIT_POLICY;
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: rejected, global: accepted }))
    .toEqual({ state: 'rejected', source: 'local', slot: 'urn:l', decision: 'urn:ld' });
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: { state: 'absent' }, global: accepted }))
    .toEqual({ state: 'accepted', source: 'inherited-global', slot: 'urn:g', decision: 'urn:gd' });
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: withdrawn, global: accepted }))
    .toMatchObject({ state: 'accepted', source: 'inherited-global' });
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: { state: 'unavailable' }, global: accepted }))
    .toEqual({ state: 'unavailable' });
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: { state: 'absent' },
    global: { state: 'unavailable' } })).toEqual({ state: 'unavailable' });
  expect(resolveAcceptance({ scope: 'local', policy: inherit, local: { state: 'absent' },
    global: { state: 'absent' } })).toEqual({ state: 'absent', source: 'none' });
  expect(resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_ISOLATE_POLICY, local: { state: 'absent' } }))
    .toEqual({ state: 'absent', source: 'none' });
  expect(resolveAcceptance({ scope: 'global', global: accepted })).toMatchObject({ state: 'accepted', source: 'global' });
  expect(resolveAcceptance({ scope: 'global', global: { state: 'unavailable' } })).toEqual({ state: 'unavailable' });
  expect(() => resolveAcceptance({ scope: 'local', policy: inherit, local: { state: 'absent' } }))
    .toThrow(InvalidStatementSchemaInput);
});

test('CTX09 schema foundation: v1 slots migrate losslessly to one decision model without inferred meaning', () => {
  const [mainVersion, senseRevision, concept, realmContext] = [id(), id(), id(), id()];
  const common = { mainVersion, senseRevision, concept, proposer: id(), headDecidedBy: id() };
  const global = convertV1ClassificationSlot({ ...common, application: id(), headDecision: id(),
    acceptanceContext: GLOBAL_CLASSIFICATION_CONTEXT, contextRevision: null, headOutcome: 'accepted',
    headBasis: 'global-curator-review' }, { statement: id(), statementRevision: id(), decision: id() });
  const realmApplication = id();
  const realmHead = id();
  const realm = convertV1ClassificationSlot({ ...common, application: realmApplication, headDecision: realmHead,
    acceptanceContext: realmContext, contextRevision: id(), headOutcome: 'rejected',
    headBasis: 'realm-manager-review' }, { statement: id(), statementRevision: id(), decision: id() });
  expect(realm.statement.meaningKey).toBe(global.statement.meaningKey);
  expect(realm.slot.id).not.toBe(global.slot.id);
  expect(realm.statement).toMatchObject({ subject: mainVersion, value: { kind: 'resource', iri: concept },
    interpretationDefinitions: [senseRevision], semanticContextRevision: null, migratedFrom: realmApplication });
  expect(realm.decision).toMatchObject({ outcome: 'rejected', convertedFrom: realmHead, predecessor: null,
    support: [realm.statement.id], basis: 'realm-manager-review' });
  expect(realm.policy).toBe(CLASSIFICATION_INHERIT_POLICY);
  expect(global.policy).toBe(CLASSIFICATION_ISOLATE_POLICY);
  const read = (converted: typeof realm): SlotReading => ({ state: 'decided', slot: converted.slot.id,
    decision: converted.decision.id, outcome: converted.decision.outcome });
  expect(resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_INHERIT_POLICY, local: read(realm),
    global: read(global) }))
    .toMatchObject({ state: 'rejected', source: 'local', decision: realm.decision.id });
  expect(() => convertV1ClassificationSlot({ ...common, application: id(), headDecision: id(),
    acceptanceContext: realmContext, contextRevision: id(), headOutcome: 'accepted', headBasis: 'global-curator-review' },
  { statement: id(), statementRevision: id(), decision: id() })).toThrow('v1 acceptance scope and basis disagree');
  const decision = { '@id': realm.decision.id, 'rdf:type': [`${RV}StatementDecision`, `${RV}RevisionAnchor`],
    'rv:component': [realm.slot.id], 'rv:outcome': [`${RV}Rejected`], 'rv:decisionBasis': [`${RV}RealmManagerReview`],
    'rv:decidedBy': [id()], 'rv:decisionPolicy': ['https://rezics.com/definition/statement-decision-v1'],
    'rv:convertedFrom': [realmHead], 'rv:support': [realm.statement.id], ...anchor('statement-decision-v1') };
  expect(check('statement-decision-v1', 'decision', decision)).toBe(true);
  expect(check('statement-decision-v1', 'decision', { ...decision, 'rv:outcome': [`${RV}Withdrawn`] })).toBe(true);
  expect(check('statement-decision-v1', 'decision', { ...decision, 'rv:outcome': [`${RV}Unknown`] })).toBe(false);
  expect(check('statement-decision-v1', 'decision', { ...decision, 'rv:support': Array.from({ length: 33 }, id) }))
    .toBe(false);
});
