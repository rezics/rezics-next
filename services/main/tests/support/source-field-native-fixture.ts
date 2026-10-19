import { afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, type Term } from 'n3';
import type { SparqlResult } from '../../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../../src/routes/dependencies.ts';
import { ownedTriples, SEMANTIC_CHANGE_FAMILY, type ResourceState } from '../../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../../src/modules/semantic/command.ts';
import { PROFILES } from '../../src/modules/semantic/schema.ts';
import { commandReceiptIri } from '../../src/modules/context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../../src/modules/classification/context.ts';
import { decisionSlotIri } from '../../src/modules/statement/schema.ts';
import { STATEMENT_FAMILIES } from '../../src/modules/statement/receipt-family.ts';
import { semanticValueRdf } from '../../src/modules/semantic/value.ts';
import { STATEMENT_V2_PROFILE, statementMeaningKeyV2, type StatementMeaningV2 } from '../../src/modules/statement/v2-schema.ts';
import { type NativeBasisVerificationInput } from '../../src/modules/semantic/native-basis.ts';
import { hash, RV, type WorkActivationEnvironment } from '../../src/modules/work/activate.ts';

export const nativeEpoch = 'a362397c-8405-4b08-b806-e354eb47a83b';
export const nativeId = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `source-field-native-basis-${Bun.randomUUIDv7()}`);
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
export const nativePrincipal = { issuer: 'https://account.test', subject: 'verified-account' } as VerifiedPrincipal;

export async function semanticFixture() {
  const component = nativeId(1), revision = nativeId(2), operation = nativeId(3), admissionId = Bun.randomUUIDv7();
  const receipt = familyReceiptIri(admissionId, SEMANTIC_CHANGE_FAMILY), generation = `urn:rezics:model-generation:${hash('model')}`;
  const state: ResourceState = { component: 'resource', types: [], lifecycle: 'active', properties: [
    { predicate: 'https://schema.org/alternateName', value: { kind: 'language-string', lexical: '原作', language: 'ja' } },
  ] };
  let manifest = '', head = revision, acknowledgedRevision = revision, succeeds = true, finalHeadMatches = true, active = true;
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: nativeEpoch, routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => { queries.push(query);
      if (query.includes('SELECT ?outcome ?reason ?kind')) return rows(succeeds ? [{ outcome: uri(RV + 'Succeeded'),
        digest: literal(hash('request')), admissionId: literal(admissionId), authorityEpoch: literal('1'), scope: literal('semantic:create:root'),
        sequence: literal('4'), epoch: literal(nativeEpoch), component: uri(component), revision: uri(acknowledgedRevision) }] : []);
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
  const input: NativeBasisVerificationInput = { actingSubject: nativeId(8), native: { kind: 'component-property', owner: 'semantic',
    target: component, component, revision, receipt, property: state.properties[0]! },
    selected: { value: '原作', language: { state: 'value', value: 'ja' } } };
  return { work, input, receipt, revision, operation, admissionId, generation, manifest, queries,
    head: (value: string) => { head = value; }, receiptRevision: (value: string) => { acknowledgedRevision = value; },
    receiptAvailable: (value: boolean) => { succeeds = value; },
    finalHeadMatches: (value: boolean) => { finalHeadMatches = value; }, active: (value: boolean) => { active = value; } };
}

export async function statementFixture() {
  const statement = nativeId(30), revision = nativeId(31), operation = nativeId(32), actor = nativeId(33), target = nativeId(34), decision = nativeId(35);
  const admissionId = Bun.randomUUIDv7(), receipt = commandReceiptIri(admissionId, STATEMENT_FAMILIES.record);
  const generation = `urn:rezics:model-generation:${hash('statement-model')}`;
  const meaning: StatementMeaningV2 = { subject: { kind: 'resource', ref: target }, predicate: 'https://schema.org/alternateName',
    relationDefinition: nativeId(37), value: { kind: 'language-string', lexical: '原作', language: 'ja' },
    applicability: [], interpretationDefinitions: [], coverage: { kind: 'subject-global' } };
  const key = statementMeaningKeyV2(meaning);
  const slot = decisionSlotIri({ kind: 'statement', statement }, GLOBAL_CLASSIFICATION_CONTEXT);
  let terminalAvailable = true, acknowledgedAdmission = admissionId;
  let manifest = '', head = revision, projection = true, adoption: 'accepted' | 'rejected' | 'absent' | 'unavailable' = 'accepted';
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: nativeEpoch, routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => { queries.push(query);
      if (query.includes('SELECT ?admission WHERE')) return rows([{ admission: literal(admissionId) }]);
      if (query.includes('SELECT ?model ?manifest ?admission')) return rows([{ model: uri(STATEMENT_V2_PROFILE),
        manifest: uri(manifest), admission: literal(admissionId), operation: uri(operation), head: uri(head) }]);
      if (query.includes('SELECT ?outcome ?reason ?digest')) return rows(terminalAvailable ? [{ outcome: uri(RV + 'Succeeded'),
        digest: literal(hash('statement-request')), id: literal(acknowledgedAdmission), epoch: literal('1'), scope: literal(`statement:speak:${actor}`),
        dataEpoch: literal(nativeEpoch), sequence: literal('4'), operation: uri(operation), component: uri(statement), revision: uri(revision) }] : []);
      if (query.includes('SELECT ?manifest ?model ?generation')) return rows([{ manifest: uri(manifest),
        model: uri(STATEMENT_V2_PROFILE), generation: uri(generation), state: uri(RV + 'Active'), operation: uri(operation),
        recordedBy: uri(actor), epoch: literal(nativeEpoch), sequence: literal('4'), head: uri(head), currentState: uri(RV + 'Active'),
        receipt: uri(receipt), family: literal(STATEMENT_FAMILIES.record), admission: literal(admissionId),
        digest: literal(hash('statement-request')), authority: literal('1'), scope: literal(`statement:speak:${actor}`) }]);
      if (query.includes('SELECT ?epoch ?sequence ?head')) return rows([{ epoch: literal(nativeEpoch), sequence: literal('5'), head: uri(head) }]);
      if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows([{ epoch: literal(nativeEpoch), sequence: literal('5'),
        context: uri(GLOBAL_CLASSIFICATION_CONTEXT), policy: uri(CLASSIFICATION_ISOLATE_POLICY) }]);
      if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) return rows([
        { statement: uri(statement), epoch: literal(nativeEpoch), sequence: literal('5'),
          ...(adoption === 'absent' ? {} : { globalSlot: uri(slot) }),
          ...(['accepted', 'rejected'].includes(adoption) ? { globalDecision: uri(decision),
            globalOutcome: uri(RV + (adoption === 'accepted' ? 'Accepted' : 'Rejected')) } : {}) },
        // A direct accepted decision does not depend on a different fact slot's availability.
        { statement: uri(key), epoch: literal(nativeEpoch), sequence: literal('5'), globalSlot: uri(nativeId(39)) },
      ]);
      if (query.includes('VALUES (?expectedP ?expectedO)')) return { boolean: projection };
      if (query.includes('ASK')) return { boolean: true };
      throw new Error('Unexpected Statement owner query');
    },
  } } as unknown as WorkActivationEnvironment;
  manifest = await sealComponentState(env, statement, STATEMENT_V2_PROFILE, { revision, meaning, meaningKey: key,
    speaker: actor, semanticContextRevision: null, state: 'active', evidence: [], recordedBy: actor,
    modelGeneration: generation, subjectRdf: semanticValueRdf(meaning.subject, () => nativeId(40)),
    valueRdf: semanticValueRdf(meaning.value, () => nativeId(41)) });
  const work = { environment: env, access: { activePrincipalId: async () => 'principal',
    canReadSemanticResource: async () => true, canReadWork: async () => false } } as unknown as
    Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections'>;
  const input = { actingSubject: actor,
    native: { kind: 'statement', owner: 'statement', target, statement, revision, receipt,
      predicate: meaning.predicate, relationDefinition: meaning.relationDefinition, value: meaning.value, context: 'global',
      qualifiers: { applicability: [], interpretationDefinitions: [] }, coverage: meaning.coverage,
      acceptance: { context: GLOBAL_CLASSIFICATION_CONTEXT, decision, source: 'global' } },
    selected: { value: '原作', language: { state: 'value', value: 'ja' } } } satisfies NativeBasisVerificationInput;
  return { work,input,receipt,revision,operation,admissionId,generation,manifest,queries,
    head: (value: string) => { head = value; },
    adoption: (value: typeof adoption) => { adoption = value; },
    receiptAdmission: (value: string) => { acknowledgedAdmission = value; },
    receiptAvailable: (value: boolean) => { terminalAvailable = value; } };
}
