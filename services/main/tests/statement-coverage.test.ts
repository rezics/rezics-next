import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { commandReceiptIri } from '../src/modules/context/command.ts';
import { semanticValueRdf, type SemanticValue } from '../src/modules/semantic/value.ts';
import { sealComponentState } from '../src/modules/semantic/command.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import type { OccurrenceState } from '../src/modules/relation/change.ts';
import { systemDisclosure } from '../src/modules/target/disclosed-references.ts';
import { statementCoverageSchema } from '../src/modules/statement/contract.ts';
import { assertParticipationCoverage, resolveStatementCoverage } from '../src/modules/statement/v2-coverage.ts';
import { readStatementV2Revision, verifyStatementV2Current } from '../src/modules/statement/v2-read.ts';
import { checkedStatementCoverage, checkedStatementMeaningV2, statementMeaningKeyV2,
  STATEMENT_V2_PROFILE, type StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { checkedRecordStatementV2, recordStatementV2, recordStatementV2Request,
  type RecordStatementV2Input } from '../src/modules/statement/v2-write.ts';
import { STATEMENT_FAMILIES, recordStatementRequest } from '../src/modules/statement/graph.ts';
import { statementMeaningKey } from '../src/modules/statement/schema.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `statement-coverage-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const quantity = (): SemanticValue => ({ kind: 'quantity', lexical: '1.50', value: { kind: 'decimal', lexical: '1.5' },
  unit: 'https://example.test/unit/gram', uncertainty: { kind: 'rational', lexical: '1/2' } });
const meaning = (): StatementMeaningV2 => ({ subject: { kind: 'external', provider: 'vndb', namespace: 'character', key: 'c123' },
  predicate: id(2), relationDefinition: id(3), value: quantity(), applicability: [], interpretationDefinitions: [],
  coverage: { kind: 'participation', occurrence: id(4), occurrenceRevision: id(5), participation: id(6) } });
const input = (): RecordStatementV2Input => {
  const { interpretationDefinitions: _, ...authored } = meaning();
  return { ...authored, profile: 'statement-v2', speaker: { kind: 'personal' },
    interpretation: { kind: 'selected' }, evidence: [id(9)], actingSubject: id(10) };
};
// The read/command fixture supplies frozen transport rows; all manifests, codecs,
// receipt identities, request binding and current-owner verification are real.
const environment = (query: (query: string) => Promise<SparqlResult>): WorkActivationEnvironment => ({
  objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: { query },
}) as unknown as WorkActivationEnvironment;

test('coverage is a mandatory closed meaning and occurrence assertions name the exact revision', () => {
  for (const bad of [undefined, {}, { kind: 'global' }, { kind: 'subject-global', occurrence: id(4) },
    { kind: 'participation', occurrence: id(4), occurrenceRevision: id(5) },
    { kind: 'participation', occurrence: id(4), occurrenceRevision: id(5), participation: 'subject' }]) {
    expect(Value.Check(statementCoverageSchema, bad)).toBe(false);
    expect(() => checkedStatementCoverage(bad)).toThrow();
  }
  expect(Value.Check(statementCoverageSchema, meaning().coverage)).toBe(true);
  const assertion = { ...meaning(), subject: { kind: 'resource' as const, ref: id(4) },
    value: { kind: 'resource' as const, ref: id(5) },
    coverage: { kind: 'occurrence' as const, occurrence: id(4), occurrenceRevision: id(5) } };
  expect(checkedStatementMeaningV2(assertion).coverage).toEqual(assertion.coverage);
  for (const value of [{ kind: 'boolean', lexical: 'true' }, { kind: 'resource', ref: id(7) }]) {
    expect(() => checkedStatementMeaningV2({ ...assertion, value } as StatementMeaningV2)).toThrow();
  }
});

test('participation coverage preserves full qualified identity and never binds a co-participant or repeat', () => {
  const state: OccurrenceState = { definition: id(3), lifecycle: 'active', applicability: [], participations: [
    { iri: id(6), role: `${id(2)}/role/subject`, participant: meaning().subject, position: 0 },
    { iri: id(7), role: `${id(2)}/role/other`, participant: { kind: 'resource', ref: id(11) } },
  ] };
  expect(() => assertParticipationCoverage(meaning(), state, [`${id(2)}/role/subject`])).not.toThrow();
  for (const subject of [
    { kind: 'external', provider: 'vndb', namespace: 'person', key: 'c123' },
    { kind: 'external', provider: 'other', namespace: 'character', key: 'c123' },
    { kind: 'resource', ref: id(11) },
  ]) expect(() => assertParticipationCoverage({ ...meaning(), subject } as StatementMeaningV2,
    state, [`${id(2)}/role/subject`])).toThrow();
  expect(() => assertParticipationCoverage(meaning(), { ...state, participations: state.participations.map(part =>
    ({ ...part, iri: part.iri === id(6) ? id(12) : part.iri })) }, [`${id(2)}/role/subject`])).toThrow();
  expect(() => assertParticipationCoverage(meaning(), state, [`${id(2)}/role/other`])).toThrow();
});

test('the V3 meaning domain retains exact values, coordinates, qualifications and repeated coverage', () => {
  const original = meaning(), key = statementMeaningKeyV2(original);
  expect(checkedStatementMeaningV2(original).value).toEqual(quantity());
  const { coverage: _, ...v1 } = original;
  expect(key).not.toBe(statementMeaningKey({ ...v1, subject: id(1), value: { kind: 'some-value' } }));
  for (const variant of [
    { ...original, coverage: { kind: 'subject-global' } },
    { ...original, coverage: { ...original.coverage, occurrenceRevision: id(15) } },
    { ...original, coverage: { ...original.coverage, participation: id(16) } },
    { ...original, value: { kind: 'unknown' } },
    { ...original, value: { kind: 'no-value' } },
    { ...original, applicability: [id(17)] },
    { ...original, qualification: { definition: id(18), interpretationContext: 'urn:example:uncertain',
      valuePrecision: 'uncertain', valueQualifiers: [], validFrom: null, validUntil: null, editionScope: null } },
  ]) expect(statementMeaningKeyV2(variant as StatementMeaningV2)).not.toBe(key);
  const scoped = { ...original, applicability: [id(17), id(18)], interpretationDefinitions: [id(20), id(21)] };
  expect(statementMeaningKeyV2(scoped)).toBe(statementMeaningKeyV2({ ...scoped,
    applicability: [...scoped.applicability].reverse(), interpretationDefinitions: [...scoped.interpretationDefinitions].reverse() }));
  expect(() => checkedStatementMeaningV2({ ...original, subject: { kind: 'external', provider: 'vndb', key: 'c123' } } as StatementMeaningV2)).toThrow();
});

test('V2 requests do not translate existential V1 values or silently admit unsupported fields', () => {
  const valid = input();
  // Interpretation definitions are resolved by the owner, never accepted from a caller.
  const { interpretationDefinitions: _, ...request } = valid as RecordStatementV2Input & { interpretationDefinitions?: string[] };
  expect(checkedRecordStatementV2(request).value).toEqual(quantity());
  const native = { ...request, subject: { kind: 'resource' as const, ref: id(1) }, value: { kind: 'no-value' as const }, coverage: { kind: 'subject-global' as const } };
  expect(recordStatementV2Request(native).digest).not.toBe(recordStatementRequest({ ...native, subject: id(1) }).digest);
  expect(() => checkedRecordStatementV2({ ...request, value: { kind: 'some-value' } } as unknown as RecordStatementV2Input)).toThrow();
  expect(() => checkedRecordStatementV2({ ...request, coverage: undefined } as unknown as RecordStatementV2Input)).toThrow();
  expect(() => checkedRecordStatementV2({ ...request, interpretationDefinitions: [id(20)] } as unknown as RecordStatementV2Input)).toThrow();
});

test('committed lost-reply replay returns the original native receipt and allocations without new owner writes', async () => {
  const { interpretationDefinitions: _, ...request } = input() as RecordStatementV2Input & { interpretationDefinitions?: string[] };
  const plan = recordStatementV2Request(request), admission: RegisteredAdmission = { id: Bun.randomUUIDv7(),
    principalId: Bun.randomUUIDv7(), actingSubject: id(10), scope: plan.scope, action: plan.action,
    requestDigest: plan.digest, idempotencyKey: 'lost-reply', authorityEpoch: '4', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: true };
  const receipt = commandReceiptIri(admission.id, STATEMENT_FAMILIES.record), queries: string[] = [];
  const env = environment(async query => { queries.push(query); expect(query).toContain(receipt);
    return rows([{ outcome: uri(RV + 'Succeeded'), digest: literal(plan.digest), id: literal(admission.id),
      epoch: literal('4'), scope: literal(plan.scope), dataEpoch: literal('epoch-one'), sequence: literal('7'),
      operation: uri(id(30)), component: uri(id(31)), revision: uri(id(32)) }]); });
  const replay = await recordStatementV2(env, admission, request, { kind: 'personal' }, async () => true);
  expect(replay).toMatchObject({ receipt, component: id(31), revision: id(32), operation: id(30), sequence: '7' });
  expect(queries).toHaveLength(1);
  await expect(recordStatementV2(env, admission, { ...request, coverage: { kind: 'subject-global' } },
    { kind: 'personal' }, async () => true)).rejects.toThrow('command receipt differs');
});

test('exact coverage uses authored roles and Work authority without inventing revision read scopes', async () => {
  const definition = id(40), definitionRevision = id(41), occurrence = id(4), revision = id(5), work = id(42);
  const state: OccurrenceState = { definition: definitionRevision, lifecycle: 'active', applicability: [], participations: [
    { iri: id(43), role: `${definition}/role/work`, participant: { kind: 'resource', ref: work } },
    { iri: id(6), role: `${definition}/role/subject`, participant: meaning().subject, position: 0 },
  ] };
  let active = true;
  const queried: string[] = [], authority: string[] = [];
  let occurrenceManifest = '', definitionManifest = '';
  const env = environment(async query => { queried.push(query);
    if (query.includes('SELECT ?manifest ?predecessor')) return rows([{ manifest: uri(occurrenceManifest), epoch: literal('epoch-one'), sequence: literal('2') }]);
    if (query.includes('SELECT ?definition ?manifest')) return rows([{ definition: uri(definition), manifest: uri(definitionManifest),
      kind: uri(RV + 'RelationDefinition'), model: uri(PROFILES.definitionV2) }]);
    if (query.includes('ASK')) return { boolean: active };
    throw new Error('Unexpected owner query');
  });
  occurrenceManifest = await sealComponentState(env, occurrence, PROFILES.relation, state);
  definitionManifest = await sealComponentState(env, definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: 4, ordered: true }], workSubjectRole: 'work',
    association: { kind: 'appearance', workRole: 'work', subjectRoles: ['subject'] },
  }, 'semantic-change-v2'));
  const read = async (ref: string) => { authority.push(ref); return ref === work; };
  const coverage = await resolveStatementCoverage(env, meaning(), read, async ref => ref === definition, systemDisclosure);
  expect(coverage.references).toContain(revision);
  expect(authority).toEqual([work]);
  expect(coverage.guard).toContain(`<${work}> a <https://schema.org/CreativeWork>`);
  active = false;
  await expect(resolveStatementCoverage(env, meaning(), read, async () => true, systemDisclosure)).rejects.toThrow('changed or is retired');
  active = true;
  await expect(resolveStatementCoverage(env, meaning(), read, async () => true, async () => new Set())).rejects.toThrow('covered occurrence is unavailable');
  expect(queried.some(query => query.includes('rv:participation') && query.includes(id(6)))).toBe(true);
});

test('exact Statement snapshots retain actual receipts, full values and current-owner checks', async () => {
  const statement = id(50), revision = id(51), actor = id(10), operation = id(52), admissionId = Bun.randomUUIDv7();
  const receipt = commandReceiptIri(admissionId, STATEMENT_FAMILIES.record), generation = `urn:rezics:model-generation:${hash('generation')}`;
  const authored = meaning(), subjectRdf = semanticValueRdf(authored.subject, () => id(53)), valueRdf = semanticValueRdf(authored.value, () => id(54));
  let currentHead = revision, actualReceipt = receipt, projectionMatches = true, manifest = '';
  const queries: string[] = [];
  const env = environment(async query => { queries.push(query);
    if (query.includes('SELECT ?manifest ?model ?generation')) return rows([{ manifest: uri(manifest), model: uri(STATEMENT_V2_PROFILE),
      generation: uri(generation), state: uri(RV + 'Active'), operation: uri(operation), recordedBy: uri(actor), epoch: literal('epoch-one'),
      sequence: literal('3'), head: uri(currentHead), currentState: uri(RV + 'Active'), receipt: uri(actualReceipt),
      family: literal(STATEMENT_FAMILIES.record), admission: literal(admissionId), digest: literal(hash('request')), authority: literal('1'), scope: literal('statement:write') }]);
    if (query.includes('VALUES (?expectedP ?expectedO)')) return { boolean: projectionMatches };
    if (query.includes('ASK')) return { boolean: true };
    throw new Error('Unexpected owner query');
  });
  manifest = await sealComponentState(env, statement, STATEMENT_V2_PROFILE, { revision, meaning: authored,
    meaningKey: statementMeaningKeyV2(authored), speaker: actor, semanticContextRevision: null, state: 'active',
    evidence: [id(9)], recordedBy: actor, modelGeneration: generation, subjectRdf, valueRdf });
  const snapshot = await readStatementV2Revision(env, statement, revision);
  expect(snapshot).toMatchObject({ receipt: { receipt, operation, component: statement, revision }, manifest, modelGeneration: generation });
  expect(snapshot.meaning.value).toEqual(quantity());
  await verifyStatementV2Current(env, snapshot);
  expect(queries.at(-1)).toContain('coveredParticipation');
  expect(queries.at(-1)).toContain(id(54));
  projectionMatches = false;
  await expect(verifyStatementV2Current(env, snapshot)).rejects.toThrow('current value or qualifiers differ');
  currentHead = id(55);
  await expect(verifyStatementV2Current(env, await readStatementV2Revision(env, statement, revision))).rejects.toThrow('head changed');
  currentHead = revision; actualReceipt = statement;
  await expect(readStatementV2Revision(env, statement, revision)).rejects.toThrow('actual command receipt');
});
