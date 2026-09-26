import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { AUTHOR_CREDIT_RELATION, authorCreditParticipations, checkedApplicability, checkedParticipations,
  InvalidRelationOccurrence, RELATION_LIMITS, RELATION_TERMS, type Participant, type RelationOccurrenceHead,
  type RelationOccurrenceRevision } from '../src/modules/relation/schema.ts';
import { allocateNativeIri, checkedNativeIri, DATASET, DEFINITION_KINDS, definitionKindIri, GRAPHS,
  IDENTITY_AXIOMS, type Lifecycle, MODEL_COMPONENT, RESERVED_OWNER_PREDICATES, RESERVED_OWNER_TYPES, modelGenerationReceiptIri, PROFILES, relationChangeReceiptIri, SEMANTIC_CHANGE_LIMITS,
  SEMANTIC_TERMS, semanticChangeReceiptIri, semanticPredicateOutcome, semanticTypeOutcome,
  type DefinitionHeadRecord, type DefinitionRevisionRecord, type ModelGenerationRecord,
  type SemanticChangeOutcome, type SemanticResourceHead, type SemanticRevisionRecord } from '../src/modules/semantic/schema.ts';
import { STAGE_LIMITS, STAGE_PROFILE, type ChangeStageOutcomeRow, type ChangeStagePageRow,
  type ChangeStagePendingRow, type ChangeStageRow, type ChangeStageValidationRow, type StageOutcome,
  type StageRejection, type StageValidationOutcome } from '../src/modules/semantic/stage-schema.ts';
import { checkedExactNumber, checkedSemanticValue, EXACT_LIMITS, exactFromEvidence, GREGORIAN,
  InvalidSemanticValue, OWL_RATIONAL, sameTermAsWorkScalar, semanticValueExport, semanticValueRdf,
  temporalParts, UnsupportedSemanticValue, workScalarAsSemantic, type ReferenceAvailability,
  type SemanticValue } from '../src/modules/semantic/value.ts';
import { scalarExport, SCALAR_PREDICATE, type WorkScalarValue } from '../src/modules/work/scalar-value.ts';

interface AuthoredProfile { id: string; shapes: readonly { iri: string; properties: readonly { path: string; hasValue?: string }[] }[] }

// The model compiler is checked by its own tooling; Main's project loads it only at runtime.
const model = join(import.meta.dir, '../../../model');
const load = async <T>(file: string): Promise<T> => await import(join(model, file)) as T;
const { renderProfile } = await load<{ renderProfile: (profile: AuthoredProfile) => string }>('compiler/ir.ts');
const { buildModelOutputs } = await load<{ buildModelOutputs: (profiles: readonly AuthoredProfile[]) => Map<string, string> }>(
  'compiler/outputs.ts');
const profileFiles = ['semantic-resource-v1', 'semantic-definition-v1', 'semantic-model-generation-v1',
  'semantic-annotation-v1', 'value-exact-v1', 'relation-occurrence-v1'];
const profiles = await Promise.all(profileFiles.map(async id => {
  const module = await load<Record<string, AuthoredProfile>>(`definitions/${id}.ts`);
  const profile = Object.values(module)[0]!;
  expect(profile.id).toBe(id);
  return profile;
}));
const byId = (id: string): AuthoredProfile => profiles.find(profile => profile.id === id)!;
const node = 'https://rezics.com/id/01990000-0000-7000-8000-00000000000a';
const nodes = () => node;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

test('MODEL14 schema: owner profiles compile, stay open on the resource and pin revision anchors', () => {
  expect(profiles.map(profile => `https://rezics.com/definition/${profile.id}`).sort())
    .toEqual(Object.values<string>(PROFILES).sort());
  const outputs = buildModelOutputs(profiles);
  for (const profile of profiles) {
    const shapes = renderProfile(profile);
    expect(outputs.get(`generated/model/contexts/${profile.id}.jsonld`)).toBeDefined();
    for (const shape of profile.shapes) {
      expect(shapes).toContain(`<${shape.iri}>`);
      const revision = shape.properties.find(property => property.path === 'rv:modelRevision');
      if (revision) expect(revision.hasValue).toBe(`<https://rezics.com/definition/${profile.id}>`);
    }
  }
  const resource = renderProfile(byId('semantic-resource-v1'));
  // Open resource: no closure and no fixed type; only the component head and forbidden merge axiom.
  expect(resource.split('<https://rezics.com/definition/semantic-resource-v1/revision-shape>')[0])
    .not.toContain('sh:closed');
  expect(resource).toContain('revision-shape>\n    a sh:NodeShape ;\n    sh:closed true');
  // The routing type rdfs:Resource is stored alongside up to 32 caller types.
  expect(resource).toContain('sh:path rdf:type ; sh:maxCount 33 ; sh:nodeKind sh:IRI ; sh:hasValue rdfs:Resource');
  expect(resource).toContain('sh:path owl:sameAs ; sh:maxCount 0');
  expect(resource).toContain('sh:path rv:semanticHead ; sh:maxCount 0');
  expect(renderProfile(byId('semantic-model-generation-v1'))).toContain('sh:hasValue rv:RejectOnViolation');
  expect(renderProfile(byId('semantic-model-generation-v1'))).toContain('sh:hasValue rv:Excluded');
  expect(renderProfile(byId('value-exact-v1'))).toContain('sh:in ( "ltr" "rtl" )');
  expect(renderProfile(byId('relation-occurrence-v1'))).toContain('sh:path rv:occurrence ; sh:minCount 1 ; sh:maxCount 1');
  for (const id of ['semantic-definition-v1', 'relation-occurrence-v1', 'value-exact-v1',
    'semantic-model-generation-v1']) {
    const profile = byId(id);
    expect(profile.shapes.every(shape => renderProfile(profile).includes(
      `<${shape.iri}>\n    a sh:NodeShape ;\n    sh:closed true`))).toBe(true);
  }
  expect(definitionKindIri('relation')).toBe('https://rezics.com/vocab/RelationDefinition');
  expect(DEFINITION_KINDS.map(definitionKindIri).every(kind =>
    renderProfile(byId('semantic-definition-v1')).includes(kind.replace('https://rezics.com/vocab/', 'rv:')))).toBe(true);
  expect(GRAPHS.current).toBe('urn:rezics:graph:current');
  expect(DATASET).toBe('urn:rezics:dataset:product');
  expect(MODEL_COMPONENT).toBe('urn:rezics:model:product');
  expect(SEMANTIC_TERMS.semanticHead).toBe('https://rezics.com/vocab/semanticHead');
  expect(SEMANTIC_CHANGE_LIMITS.typesPerResource).toBe(32);
});

test('MODEL01/MODEL08/MODEL19 schema: types are descriptive; owner, schema and identity axioms are refused', () => {
  expect(semanticTypeOutcome('https://schema.org/Person')).toBe('admitted');
  expect(semanticTypeOutcome('https://example.org/vocab/Administrator')).toBe('admitted');
  expect(semanticTypeOutcome('https://schema.org/SoftwareApplication')).toBe('admitted');
  expect(semanticTypeOutcome('https://schema.org/CreativeWork')).toBe('reserved-owner');
  expect(semanticTypeOutcome('https://rezics.com/vocab/MainVersion')).toBe('reserved-owner');
  expect(semanticTypeOutcome('http://www.w3.org/2002/07/owl#FunctionalProperty')).toBe('identity-axiom');
  expect(semanticTypeOutcome('http://www.w3.org/2002/07/owl#Class')).toBe('schema-axiom');
  expect(semanticTypeOutcome('http://www.w3.org/ns/shacl#NodeShape')).toBe('schema-axiom');
  expect(semanticTypeOutcome('not an iri')).toBe('invalid');
  expect(semanticPredicateOutcome('http://www.w3.org/2002/07/owl#sameAs')).toBe('identity-axiom');
  expect(semanticPredicateOutcome('http://www.w3.org/2000/01/rdf-schema#subClassOf')).toBe('schema-axiom');
  expect(semanticPredicateOutcome('http://www.w3.org/2000/01/rdf-schema#label')).toBe('reserved-owner');
  expect(semanticPredicateOutcome('https://rezics.com/vocab/scalarValue')).toBe('reserved-owner');
  expect(semanticPredicateOutcome('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe('admitted');
  expect(semanticPredicateOutcome('https://schema.org/birthDate')).toBe('admitted');
  const admission = '01990000-0000-7000-8000-000000000001';
  const receipts = [semanticChangeReceiptIri(admission), relationChangeReceiptIri(admission),
    modelGenerationReceiptIri(admission)];
  expect(new Set(receipts).size).toBe(3);
  for (const receipt of receipts) expect(receipt).toMatch(/^urn:rezics:receipt:[0-9a-f]{64}$/);
  const first = allocateNativeIri(); const second = allocateNativeIri();
  expect(first).not.toBe(second);
  expect(checkedNativeIri(first)).toBe(first);
  expect(() => checkedNativeIri('https://rezics.com/id/not-a-uuid')).toThrow('invalid native identity');
  const outcome: SemanticChangeOutcome = 'generation-changed';
  expect(outcome).toBe('generation-changed');
  expect([...IDENTITY_AXIOMS].every(term => semanticTypeOutcome(term) === 'identity-axiom')).toBe(true);
  expect([...RESERVED_OWNER_TYPES].every(term => semanticTypeOutcome(term) === 'reserved-owner')).toBe(true);
  expect([...RESERVED_OWNER_PREDICATES].every(term => semanticPredicateOutcome(term) === 'reserved-owner')).toBe(true);
});

test('MODEL02 schema: the general value codec reproduces every Work scalar state', () => {
  const states: WorkScalarValue[] = [{ kind: 'integer', lexical: '0' }, { kind: 'boolean', lexical: 'false' },
    { kind: 'string', lexical: '' }, { kind: 'unknown' }, { kind: 'no-value' }];
  for (const state of states) {
    const general = workScalarAsSemantic(state);
    expect(checkedSemanticValue(general)).toEqual(general);
    expect(sameTermAsWorkScalar(state)).toBe(true);
    expect(scalarExport(node, state)[SCALAR_PREDICATE]).toEqual([semanticValueExport(general)]);
  }
});

test('MODEL03 schema: huge integers and exact fractions never pass through JSON numbers', () => {
  const huge = `${2n ** 400n}`;
  const integer = checkedSemanticValue(JSON.parse(JSON.stringify({ kind: 'integer', lexical: huge })));
  expect(integer).toEqual({ kind: 'integer', lexical: huge });
  expect(semanticValueRdf(integer, nodes).object).toBe(`"${huge}"^^<${XSD}integer>`);
  expect(semanticValueExport(integer)).toEqual({ '@value': huge, '@type': `${XSD}integer` });
  expect(checkedExactNumber({ kind: 'decimal', lexical: '-0.000000000000000000000000001' }).lexical)
    .toBe('-0.000000000000000000000000001');
  const third = checkedSemanticValue({ kind: 'rational', lexical: '-1/3' });
  expect(semanticValueRdf(third, nodes).object).toBe(`"-1/3"^^<${OWL_RATIONAL}>`);
  for (const bad of [{ kind: 'integer', lexical: '007' }, { kind: 'integer', lexical: '-0' },
    { kind: 'integer', lexical: 7 }, { kind: 'decimal', lexical: '1.50' }, { kind: 'decimal', lexical: '1' },
    { kind: 'rational', lexical: '2/4' }, { kind: 'rational', lexical: '3/1' }, { kind: 'rational', lexical: '0/5' },
    { kind: 'integer', lexical: '1'.repeat(EXACT_LIMITS.digits + 3) }]) {
    expect(() => checkedSemanticValue(bad)).toThrow(InvalidSemanticValue);
  }
  expect(exactFromEvidence('1.50')).toEqual({ value: { kind: 'decimal', lexical: '1.5' }, decimalPlaces: 2 });
  expect(exactFromEvidence('-0.0')).toEqual({ value: { kind: 'integer', lexical: '0' }, decimalPlaces: 1 });
  const unit = 'http://qudt.org/vocab/unit/KiloGM';
  const mass = checkedSemanticValue({ kind: 'quantity', lexical: '1.50', value: { kind: 'decimal', lexical: '1.5' },
    unit, uncertainty: { kind: 'decimal', lexical: '0.05' } });
  const rdf = semanticValueRdf(mass, nodes);
  expect(rdf.node?.shape).toBe('quantity');
  expect(rdf.node?.triples).toContain(`<${node}> <https://schema.org/value> "1.5"^^<${XSD}decimal>`);
  expect(rdf.node?.triples).toContain(`<${node}> <https://rezics.com/vocab/lexicalForm> "1.50"^^<${XSD}string>`);
  expect(rdf.node?.triples).toContain(`<${node}> <https://rezics.com/vocab/decimalPlaces> "2"^^<${XSD}integer>`);
  expect(checkedSemanticValue({ kind: 'quantity', lexical: '2/3', value: { kind: 'rational', lexical: '2/3' }, unit }))
    .toMatchObject({ value: { kind: 'rational', lexical: '2/3' } });
  expect(() => checkedSemanticValue({ kind: 'quantity', lexical: '1.40', value: { kind: 'decimal', lexical: '1.5' }, unit }))
    .toThrow('quantity lexical evidence differs');
  expect(() => checkedSemanticValue({ kind: 'quantity', lexical: '1', value: { kind: 'integer', lexical: '1' },
    unit: 'kg' })).toThrow('unit definition must be an IRI');
});

test('MODEL04 schema: temporal precision, offset, calendar and text direction survive normalization', () => {
  const month = checkedSemanticValue({ kind: 'temporal', lexical: '2026-03', precision: 'month', calendar: 'gregorian' });
  const monthRdf = semanticValueRdf(month, nodes).node!;
  expect(monthRdf.triples).toContain(`<${node}> <http://www.w3.org/2006/time#unitType> <http://www.w3.org/2006/time#unitMonth>`);
  expect(monthRdf.triples).toContain(`<${node}> <http://www.w3.org/2006/time#hasTRS> <${GREGORIAN}>`);
  expect(monthRdf.triples.some(triple => triple.includes('earliest'))).toBe(false);
  expect(temporalParts('2026-03-08T10:00+09:00', 'minute'))
    .toEqual({ offset: '+09:00', earliest: '2026-03-08T01:00:00Z', latest: '2026-03-08T01:00:59.999999999Z' });
  expect(temporalParts('2026-03-08T23:59:59.50-00:30', 'second'))
    .toEqual({ offset: '-00:30', earliest: '2026-03-09T00:29:59.5Z', latest: '2026-03-09T00:29:59.509999999Z' });
  expect(temporalParts('0099-12-31', 'day')).toEqual({});
  const zoned = checkedSemanticValue({ kind: 'temporal', lexical: '2026-03-08T10:00:00Z', precision: 'second',
    calendar: 'gregorian', timeZone: 'Asia/Tokyo' });
  expect(semanticValueRdf(zoned, nodes).node!.triples).toContain(
    `<${node}> <https://rezics.com/vocab/lexicalForm> "2026-03-08T10:00:00Z"^^<${XSD}string>`);
  for (const bad of [
    { kind: 'temporal', lexical: '2026-02-30', precision: 'day', calendar: 'gregorian' },
    { kind: 'temporal', lexical: '2026-03-08+09:00', precision: 'day', calendar: 'gregorian' },
    { kind: 'temporal', lexical: '2026-03', precision: 'day', calendar: 'gregorian' },
    { kind: 'temporal', lexical: '2026-03-08T10:00+14:30', precision: 'minute', calendar: 'gregorian' },
    { kind: 'temporal', lexical: '2026', precision: 'year', calendar: 'gregorian', timeZone: 'Mars/Base' },
  ]) expect(() => checkedSemanticValue(bad)).toThrow(InvalidSemanticValue);
  expect(() => checkedSemanticValue({ kind: 'temporal', lexical: '1447', precision: 'year', calendar: 'islamic' }))
    .toThrow(UnsupportedSemanticValue);
  const arabic = checkedSemanticValue({ kind: 'language-string', lexical: 'مرحبا', language: 'ar', direction: 'rtl' });
  const arabicRdf = semanticValueRdf(arabic, nodes);
  expect(arabicRdf.node?.shape).toBe('directional-text');
  expect(arabicRdf.node?.triples).toContain(
    `<${node}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#direction> "rtl"^^<${XSD}string>`);
  expect(semanticValueExport(arabic)).toEqual({ '@value': 'مرحبا', '@language': 'ar', '@direction': 'rtl' });
  expect(semanticValueRdf(checkedSemanticValue({ kind: 'language-string', lexical: 'Hi', language: 'en-GB' }), nodes))
    .toEqual({ object: '"Hi"@en-GB' });
  expect(() => checkedSemanticValue({ kind: 'language-string', lexical: 'Hi', language: 'en-gb' }))
    .toThrow('not canonical');
  expect(() => checkedSemanticValue({ kind: 'string', lexical: '\ud800' })).toThrow(InvalidSemanticValue);
});

test('MODEL10 schema: references are typed; unavailable carries no referent detail', () => {
  const external = checkedSemanticValue({ kind: 'external', provider: 'open-library', namespace: 'author',
    key: '/authors/OL1A' });
  const rdf = semanticValueRdf(external, nodes);
  expect(rdf.node?.shape).toBe('external-reference');
  expect(rdf.node?.triples.some(triple => triple.includes('sameAs'))).toBe(false);
  expect(() => checkedSemanticValue({ kind: 'resource', ref: 'https://example.org/private' })).toThrow(InvalidSemanticValue);
  expect(() => checkedSemanticValue(null)).toThrow(InvalidSemanticValue);
  expect(() => checkedSemanticValue({ kind: 'unknown', lexical: '' })).toThrow(InvalidSemanticValue);
  const unavailable: ReferenceAvailability = { state: 'unavailable' };
  expect(Object.keys(unavailable)).toEqual(['state']);
  const value: SemanticValue = { kind: 'resource', ref: node };
  expect(semanticValueExport(value)).toEqual({ '@id': node });
});

test('MODEL05/MODEL06 schema: participations bind one occurrence; author credit maps without a copy', () => {
  const roles = [{ role: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000b1', minParticipants: 1,
    maxParticipants: 1, ordered: false },
  { role: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000b2', minParticipants: 1,
    maxParticipants: 4, ordered: true }];
  const a = { kind: 'resource', ref: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000c1' };
  const b = { kind: 'resource', ref: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000c2' };
  const input = [{ role: roles[0]!.role, participant: a }, { role: roles[1]!.role, participant: b, position: 0 },
    { role: roles[1]!.role, participant: a, position: 1 }];
  const first = checkedParticipations(roles, input);
  const second = checkedParticipations(roles, input);
  expect(first).toEqual(second);
  expect(first).toHaveLength(3);
  for (const [bad, message] of [
    [[...input, { role: roles[1]!.role, participant: b, position: 2 }], 'repeats within one role'],
    [[{ role: roles[1]!.role, participant: b, position: 0 }], 'cardinality'],
    [[{ role: roles[0]!.role, participant: a, position: 0 }, input[1]], 'position'],
    [[{ role: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000ff', participant: a }], 'not declared'],
    [[{ role: roles[0]!.role, participant: { kind: 'string', lexical: 'x' } }, input[1]], 'native or external'],
  ] as const) expect(() => checkedParticipations(roles, bad)).toThrow(message);
  expect(() => checkedParticipations(roles, Array.from({ length: RELATION_LIMITS.participants + 1 }, () => input[0])))
    .toThrow(InvalidRelationOccurrence);
  expect(checkedApplicability([b.ref, a.ref])).toEqual([a.ref, b.ref]);
  const credit = authorCreditParticipations({ work: a.ref, externalKey: '/authors/OL1A', position: 0 });
  const participants: Participant[] = credit.map(item => item.participant);
  expect(participants.map(item => item.kind)).toEqual(['resource', 'external']);
  expect(checkedParticipations(AUTHOR_CREDIT_RELATION.roles, credit)).toEqual(credit);
  expect(JSON.stringify(credit)).not.toContain('schema.org/author');
  expect(RELATION_TERMS.back).toBe('https://rezics.com/vocab/occurrence');
});

test('MODEL21/MODEL22 schema: typed records name the reused anchors and the fixed stage posture', () => {
  const generation: ModelGenerationRecord = { generation: node, generationNumber: '1', predecessor: null,
    manifest: `urn:rezics:sha256:${'a'.repeat(64)}`, commandModuleVersion: '0.5.29', entailment: 'none',
    dataEpoch: 'epoch', sequence: '1' };
  const revision: SemanticRevisionRecord = { revision: node, resource: node, predecessor: null, lifecycle: 'active',
    operation: node, manifest: generation.manifest, modelGeneration: generation.generation, dataEpoch: 'epoch', sequence: '2' };
  const definitionHead: DefinitionHeadRecord = { definition: node, kind: 'relation', head: node, successor: null };
  const definition: DefinitionRevisionRecord = { ...revision, definition: node, kind: 'relation',
    lifecycle: 'retired', successor: node };
  const head: SemanticResourceHead = { resource: node, head: node, types: ['https://schema.org/Person'] };
  const occurrence: RelationOccurrenceHead = { occurrence: node, definition: node, head: node,
    participations: [], applicability: [] };
  const occurrenceRevision: RelationOccurrenceRevision = { ...revision, occurrence: node, definition: node,
    participantCount: 2 };
  expect([revision, definitionHead, definition, head, occurrence, occurrenceRevision].every(Boolean)).toBe(true);
  const stage: Pick<ChangeStageRow, 'profile' | 'validation_posture'> = { profile: STAGE_PROFILE,
    validation_posture: 'reject' };
  const rows: [ChangeStagePendingRow?, ChangeStagePageRow?, ChangeStageValidationRow?, ChangeStageOutcomeRow?] = [];
  const terminal: [StageValidationOutcome, StageOutcome, StageRejection, Lifecycle] =
    ['nonconforming', 'rejected', 'generation-changed', 'retired'];
  expect(terminal).toHaveLength(4);
  expect(stage).toEqual({ profile: 'semantic-change-bulk-v1', validation_posture: 'reject' });
  expect(rows).toHaveLength(0);
  expect(STAGE_LIMITS.pages).toBe(4096);
});
