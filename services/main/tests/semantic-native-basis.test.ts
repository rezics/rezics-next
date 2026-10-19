import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, type Term } from 'n3';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ownedTriples, SEMANTIC_CHANGE_FAMILY, type ResourceState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { commandReceiptIri } from '../src/modules/context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../src/modules/classification/context.ts';
import { decisionSlotIri } from '../src/modules/statement/schema.ts';
import { STATEMENT_FAMILIES } from '../src/modules/statement/receipt-family.ts';
import { semanticValueRdf } from '../src/modules/semantic/value.ts';
import { STATEMENT_V2_PROFILE, statementMeaningKeyV2, type StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { selectedNativeValueMatches, verifyAcknowledgedSemanticBasis,
  type NativeBasisVerificationInput } from '../src/modules/semantic/native-basis.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `semantic-native-basis-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const binding = (term: Term) => term.termType === 'NamedNode' ? uri(term.value) : {
  ...literal(term.value), ...(term.termType === 'Literal' ? { datatype: term.datatype.value,
    ...(term.language ? { 'xml:lang': term.language } : {}) } : {}),
};
const principal = { issuer: 'https://account.test', subject: 'verified-account' } as VerifiedPrincipal;

test('retained selection comparison preserves type, exact lexical and language', () => {
  const selected = (value: unknown, language: NativeBasisVerificationInput['selected']['language'] = { state: 'omitted' }) => ({ value, language });
  expect(selectedNativeValueMatches({ kind: 'string', lexical: '原作' }, selected('原作'))).toBe(true);
  expect(selectedNativeValueMatches({ kind: 'language-string', lexical: '原作', language: 'ja' }, selected('原作'))).toBe(false);
  expect(selectedNativeValueMatches({ kind: 'language-string', lexical: '原作', language: 'ja' }, selected('原作', { state: 'value', value: 'ja' }))).toBe(true);
  expect(selectedNativeValueMatches({ kind: 'language-string', lexical: '原作', language: 'ja' }, selected('原作', { state: 'value', value: 'zh' }))).toBe(false);
  expect(selectedNativeValueMatches({ kind: 'integer', lexical: '7' }, selected(7))).toBe(true);
  expect(selectedNativeValueMatches({ kind: 'integer', lexical: '9007199254740993' }, selected(9007199254740992))).toBe(false);
  expect(selectedNativeValueMatches({ kind: 'integer', lexical: '7' }, selected('7'))).toBe(false);
  expect(selectedNativeValueMatches({ kind: 'unknown' }, selected({ kind: 'some-value' }))).toBe(false);
  expect(selectedNativeValueMatches({ kind: 'no-value' }, selected(null))).toBe(false);
  const quantity = { kind: 'quantity' as const, lexical: '1.50', value: { kind: 'decimal' as const, lexical: '1.5' }, unit: 'https://example.test/unit/g' };
  expect(selectedNativeValueMatches(quantity, selected({ ...quantity, value: { lexical: '1.5', kind: 'decimal' } }))).toBe(true);
  expect(selectedNativeValueMatches(quantity, selected('1.50'))).toBe(false);
  expect(selectedNativeValueMatches(quantity, selected({ ...quantity, lexical: '1.5' }))).toBe(false);
});

async function fixture() {
  const component = id(1), revision = id(2), operation = id(3), admissionId = Bun.randomUUIDv7();
  const receipt = familyReceiptIri(admissionId, SEMANTIC_CHANGE_FAMILY), generation = `urn:rezics:model-generation:${hash('model')}`;
  const state: ResourceState = { component: 'resource', types: [], lifecycle: 'active', properties: [
    { predicate: 'https://example.test/property/origin', value: { kind: 'language-string', lexical: '原作', language: 'ja' } },
  ] };
  let manifest = '', head = revision, acknowledgedRevision = revision, succeeds = true, finalHeadMatches = true, active = true;
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => { queries.push(query);
      if (query.includes('SELECT ?outcome ?reason ?kind')) return rows(succeeds ? [{ outcome: uri(RV + 'Succeeded'),
        digest: literal(hash('request')), admissionId: literal(admissionId), authorityEpoch: literal('1'), scope: literal(`semantic:edit:${component}`),
        sequence: literal('4'), epoch: literal('epoch-one'), component: uri(component), revision: uri(acknowledgedRevision) }] : []);
      if (query.includes('SELECT ?head ?manifest ?model')) return rows([{ head: uri(head), manifest: uri(manifest) }]);
      if (query.includes('SELECT ?p ?o')) return rows(ownedTriples(component, state, head).flatMap(triple =>
        new Parser().parse(`<${component}> ${triple} .`).map(quad => ({ p: binding(quad.predicate), o: binding(quad.object) }))));
      if (query.includes('SELECT ?operation ?generation')) return rows([{ operation: uri(operation), generation: uri(generation) }]);
      if (query.includes('ASK')) return { boolean: finalHeadMatches };
      throw new Error('Unexpected native owner query');
    },
  } } as unknown as WorkActivationEnvironment;
  manifest = await sealComponentState(env, component, PROFILES.resource, state);
  const work = { environment: env, access: { activePrincipalId: async () => active ? 'principal' : null,
    canReadSemanticResource: async () => true, canReadWork: async () => false } } as unknown as
    Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections'>;
  const input: NativeBasisVerificationInput = { actingSubject: id(8), native: { kind: 'component-property', owner: 'semantic',
    target: component, component, revision, receipt, property: state.properties[0]! },
    selected: { value: '原作', language: { state: 'value', value: 'ja' } } };
  return { work, input, receipt, revision, operation, generation, manifest, queries, admissionId,
    head: (value: string) => { head = value; }, receiptRevision: (value: string) => { acknowledgedRevision = value; },
    receiptAvailable: (value: boolean) => { succeeds = value; },
    finalHeadMatches: (value: boolean) => { finalHeadMatches = value; }, active: (value: boolean) => { active = value; } };
}

test('Source owner verifier resolves the actual Semantic command, exact projection, selected value and head', async () => {
  const f = await fixture();
  expect(await verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).toEqual({ native: f.input.native,
    receipt: f.receipt, revision: f.revision, operation: f.operation, manifest: f.manifest, modelGeneration: f.generation,
    commandReceipt: { outcome: 'succeeded', receipt: f.receipt, admissionId: f.admissionId, requestDigest: hash('request'),
      authorityEpoch: '1', scope: `semantic:edit:${f.input.native.target}`, dataEpoch: 'epoch-one', sequence: '4',
      component: f.input.native.target, revision: f.revision, operation: f.operation },
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch-one', sequence: '4' }, headGuarantee: 'verified-before-commit' });
  expect(f.queries.at(-1)).toContain(f.receipt);
  expect(f.queries.at(-1)).toContain('semanticHead');
  expect(f.queries.some(query => query.includes('SELECT ?p ?o'))).toBe(true);
});

test('Source owner verifier distinguishes current head, target, selected value, receipt and missing evidence', async () => {
  const f = await fixture();
  const expectCode = async (input: NativeBasisVerificationInput, code: string, status: number) => {
    try { await verifyAcknowledgedSemanticBasis(f.work, principal, input); throw new Error('expected owner refusal'); }
    catch (error) { expect(error).toMatchObject({ code, status }); }
  };
  await expectCode({ ...f.input, native: { ...f.input.native, target: id(9) } }, 'native_target_mismatch', 422);
  await expectCode({ ...f.input, selected: { value: '改作', language: { state: 'value', value: 'ja' } } }, 'native_value_mismatch', 422);
  await expectCode({ ...f.input, native: { ...f.input.native, receipt: id(1) } }, 'native_receipt_mismatch', 422);
  f.receiptRevision(id(9));
  await expectCode(f.input, 'native_receipt_mismatch', 422);
  f.receiptRevision(f.revision); f.head(id(10));
  await expectCode(f.input, 'native_head_mismatch', 409);
  f.head(f.revision); f.finalHeadMatches(false);
  await expectCode(f.input, 'native_head_mismatch', 409);
  f.finalHeadMatches(true); f.receiptAvailable(false);
  await expectCode(f.input, 'native_basis_unavailable', 503);
  f.receiptAvailable(true); f.active(false);
  await expectCode(f.input, 'native_basis_unavailable', 503);
});

test('a Statement identity or an arbitrary revision never stands in for an acknowledged command receipt', async () => {
  const f = await fixture();
  const native = { kind: 'statement' as const, owner: 'statement' as const, target: id(1), statement: id(2), revision: id(3),
    receipt: id(2), predicate: id(4), relationDefinition: id(5), value: { kind: 'string' as const, lexical: 'retained' },
    context: 'global', qualifiers: { applicability: [], interpretationDefinitions: [] }, acceptance: null,
    coverage: { kind: 'subject-global' as const } };
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, { ...f.input, native })).rejects.toMatchObject({
    code: 'native_receipt_mismatch', status: 422 });
  expect(f.queries).toHaveLength(0);
});

test('Statement verification resolves the actual command, exact typed meaning and current adoption independently', async () => {
  const statement = id(30), revision = id(31), operation = id(32), actor = id(33), target = id(34), decision = id(35);
  const admissionId = Bun.randomUUIDv7(), receipt = commandReceiptIri(admissionId, STATEMENT_FAMILIES.record);
  const generation = `urn:rezics:model-generation:${hash('statement-model')}`;
  const meaning: StatementMeaningV2 = { subject: { kind: 'resource', ref: target }, predicate: id(36),
    relationDefinition: id(37), value: { kind: 'language-string', lexical: '原作', language: 'ja' },
    applicability: [], interpretationDefinitions: [], coverage: { kind: 'subject-global' } };
  const key = statementMeaningKeyV2(meaning);
  const slot = decisionSlotIri({ kind: 'statement', statement }, GLOBAL_CLASSIFICATION_CONTEXT);
  let manifest = '', head = revision, projection = true, adoption: 'accepted' | 'rejected' | 'absent' | 'unavailable' = 'accepted';
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => { queries.push(query);
      if (query.includes('SELECT ?model ?manifest ?admission')) return rows([{ model: uri(STATEMENT_V2_PROFILE),
        manifest: uri(manifest), admission: literal(admissionId), operation: uri(operation), head: uri(head) }]);
      if (query.includes('SELECT ?outcome ?reason ?digest')) return rows([{ outcome: uri(RV + 'Succeeded'),
        digest: literal(hash('statement-request')), id: literal(admissionId), epoch: literal('1'), scope: literal('statement:write'),
        dataEpoch: literal('epoch-one'), sequence: literal('4'), operation: uri(operation), component: uri(statement), revision: uri(revision) }]);
      if (query.includes('SELECT ?manifest ?model ?generation')) return rows([{ manifest: uri(manifest),
        model: uri(STATEMENT_V2_PROFILE), generation: uri(generation), state: uri(RV + 'Active'), operation: uri(operation),
        recordedBy: uri(actor), epoch: literal('epoch-one'), sequence: literal('4'), head: uri(head), currentState: uri(RV + 'Active'),
        receipt: uri(receipt), family: literal(STATEMENT_FAMILIES.record), admission: literal(admissionId),
        digest: literal(hash('statement-request')), authority: literal('1'), scope: literal('statement:write') }]);
      if (query.includes('SELECT ?epoch ?sequence ?head')) return rows([{ epoch: literal('epoch-one'), sequence: literal('5'), head: uri(head) }]);
      if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows([{ epoch: literal('epoch-one'), sequence: literal('5'),
        context: uri(GLOBAL_CLASSIFICATION_CONTEXT), policy: uri(CLASSIFICATION_ISOLATE_POLICY) }]);
      if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) return rows([
        { statement: uri(statement), epoch: literal('epoch-one'), sequence: literal('5'),
          ...(adoption === 'absent' ? {} : { globalSlot: uri(slot) }),
          ...(['accepted', 'rejected'].includes(adoption) ? { globalDecision: uri(decision),
            globalOutcome: uri(RV + (adoption === 'accepted' ? 'Accepted' : 'Rejected')) } : {}) },
        // A direct accepted decision does not depend on a different fact slot's availability.
        { statement: uri(key), epoch: literal('epoch-one'), sequence: literal('5'), globalSlot: uri(id(39)) },
      ]);
      if (query.includes('VALUES (?expectedP ?expectedO)')) return { boolean: projection };
      if (query.includes('ASK')) return { boolean: true };
      throw new Error('Unexpected Statement owner query');
    },
  } } as unknown as WorkActivationEnvironment;
  manifest = await sealComponentState(env, statement, STATEMENT_V2_PROFILE, { revision, meaning, meaningKey: key,
    speaker: actor, semanticContextRevision: null, state: 'active', evidence: [], recordedBy: actor,
    modelGeneration: generation, subjectRdf: semanticValueRdf(meaning.subject, () => id(40)),
    valueRdf: semanticValueRdf(meaning.value, () => id(41)) });
  const work = { environment: env, access: { activePrincipalId: async () => 'principal',
    canReadSemanticResource: async () => true, canReadWork: async () => false } } as unknown as
    Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections'>;
  const input = { actingSubject: actor,
    native: { kind: 'statement', owner: 'statement', target, statement, revision, receipt,
      predicate: meaning.predicate, relationDefinition: meaning.relationDefinition, value: meaning.value, context: 'global',
      qualifiers: { applicability: [], interpretationDefinitions: [] }, coverage: meaning.coverage,
      acceptance: { context: GLOBAL_CLASSIFICATION_CONTEXT, decision, source: 'global' } },
    selected: { value: '原作', language: { state: 'value', value: 'ja' } } } satisfies NativeBasisVerificationInput;
  expect(await verifyAcknowledgedSemanticBasis(work, principal, input)).toMatchObject({ native: input.native,
    receipt, revision, operation, manifest, modelGeneration: generation, headGuarantee: 'verified-before-commit' });
  expect(queries.at(-1)).toContain(receipt);
  expect(queries.at(-1)).toContain('rv:sequence 5');
  await expect(verifyAcknowledgedSemanticBasis(work, principal, { ...input, native: {
    ...input.native, coverage: undefined } })).rejects.toMatchObject({ code: 'native_value_mismatch', status: 422 });
  await expect(verifyAcknowledgedSemanticBasis(work, principal, { ...input, selected: {
    value: '原作', language: { state: 'value', value: 'zh' } } })).rejects.toMatchObject({ code: 'native_value_mismatch', status: 422 });
  adoption = 'rejected';
  await expect(verifyAcknowledgedSemanticBasis(work, principal, input)).rejects.toMatchObject({ code: 'native_value_mismatch', status: 422 });
  adoption = 'unavailable';
  await expect(verifyAcknowledgedSemanticBasis(work, principal, input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  adoption = 'accepted'; projection = false;
  await expect(verifyAcknowledgedSemanticBasis(work, principal, input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  projection = true; head = id(42);
  await expect(verifyAcknowledgedSemanticBasis(work, principal, input)).rejects.toMatchObject({ code: 'native_head_mismatch', status: 409 });
});
