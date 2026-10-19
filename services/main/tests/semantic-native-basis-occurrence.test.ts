import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { commandReceiptIri } from '../src/modules/context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../src/modules/classification/context.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import { verifyAcknowledgedSemanticBasis, type NativeBasisVerificationInput } from '../src/modules/semantic/native-basis.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { semanticValueRdf } from '../src/modules/semantic/value.ts';
import { RELATION_CHANGE_FAMILY, type OccurrenceState } from '../src/modules/relation/change.ts';
import { RELATION_V2_PROFILE } from '../src/modules/relation/v2-schema.ts';
import { STATEMENT_FAMILIES } from '../src/modules/statement/receipt-family.ts';
import { decisionSlotIri } from '../src/modules/statement/schema.ts';
import { OCCURRENCE_ASSERTION_NOTATION, STATEMENT_V2_PROFILE, statementMeaningKeyV2,
  type StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `semantic-native-occurrence-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const principal = { issuer: 'https://account.test', subject: 'verified-account' } as VerifiedPrincipal;

/** Controlled owner transport with actual sealed manifests and receipt domains.
 * This is not a native command, public-API or corpus adoption fixture. */
async function fixture(privateMeaning = false) {
  const occurrence = id(100), occurrenceRevision = id(101), workId = id(102), subject = id(103),
    definition = id(104), definitionRevision = id(105), property = id(106), propertyRevision = id(107), actor = id(112);
  const generation = `urn:rezics:model-generation:${hash('native-coverage-model')}`;
  const relationAdmission = Bun.randomUUIDv7(), relationReceipt = familyReceiptIri(relationAdmission, RELATION_CHANGE_FAMILY);
  const occurrenceState: OccurrenceState = { profile: 'relation-change-v2', definition: definitionRevision,
    lifecycle: 'active', applicability: [], attributionProofs: [], participations: [
      { iri: id(120), role: `${definition}/role/work`, participant: { kind: 'resource', ref: workId }, attributionSupports: [] },
      { iri: id(121), role: `${definition}/role/subject`, participant: { kind: 'resource', ref: subject }, position: 0, attributionSupports: [] },
      // The same subject may occupy another declared role. Repetition within a
      // single role remains invalid under the existing occurrence contract.
      { iri: id(122), role: `${definition}/role/alternate`, participant: { kind: 'resource', ref: subject }, position: 0, attributionSupports: [] },
    ] };
  const records = [
    { statement: id(108), revision: id(109), operation: id(115), decision: id(113), admission: Bun.randomUUIDv7(),
      meaning: { subject: { kind: 'resource', ref: occurrence }, predicate: property, relationDefinition: propertyRevision,
        value: { kind: 'resource', ref: occurrenceRevision }, applicability: [], interpretationDefinitions: [],
        coverage: { kind: 'occurrence', occurrence, occurrenceRevision } } as StatementMeaningV2 },
    { statement: id(110), revision: id(111), operation: id(116), decision: id(114), admission: Bun.randomUUIDv7(),
      meaning: { subject: { kind: 'resource', ref: subject }, predicate: id(123), relationDefinition: id(124),
        value: { kind: 'boolean', lexical: 'true' }, applicability: [], interpretationDefinitions: [],
        coverage: { kind: 'participation', occurrence, occurrenceRevision, participation: id(121) } } as StatementMeaningV2 },
  ].map(record => ({ ...record, receipt: commandReceiptIri(record.admission, STATEMENT_FAMILIES.record),
    key: statementMeaningKeyV2(record.meaning), manifest: '' }));
  const [assertion, trait] = records as [typeof records[number], typeof records[number]];
  let occurrenceManifest = '', definitionManifest = '', propertyManifest = '';
  let occurrenceActive = true, assertionVisible = true, assertionAdopted = true, relationAcknowledged = true,
    privateReadable = true, withdrawPrivateAtCompletion = false, privateReads = 0, finalHeadMatches = true;
  let inventory: Row[] | null = null;
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      const record = records.find(record => query.includes(`<${record.statement}>`));
      if (query.includes('SELECT DISTINCT ?statement ?revision')) return rows(inventory ?? (assertionVisible
        ? [{ statement: uri(assertion.statement), revision: uri(assertion.revision) }] : []));
      if (query.includes('SELECT ?model ?manifest ?admission')) {
        if (!record) throw new Error('Missing exact Statement selector');
        return rows([{ model: uri(STATEMENT_V2_PROFILE), manifest: uri(record.manifest), admission: literal(record.admission),
          operation: uri(record.operation), head: uri(record.revision) }]);
      }
      if (query.includes('SELECT ?outcome ?reason ?digest')) {
        const acknowledged = records.find(record => query.includes(`<${record.receipt}>`))!;
        return rows([{ outcome: uri(RV + 'Succeeded'), digest: literal(hash(acknowledged.statement)), id: literal(acknowledged.admission),
          epoch: literal('7'), scope: literal('statement:write'), dataEpoch: literal('epoch-one'), sequence: literal('4'),
          operation: uri(acknowledged.operation), component: uri(acknowledged.statement), revision: uri(acknowledged.revision) }]);
      }
      if (query.includes('SELECT ?manifest ?model ?generation')) {
        if (!record) throw new Error('Missing exact Statement snapshot');
        return rows([{ manifest: uri(record.manifest), model: uri(STATEMENT_V2_PROFILE), generation: uri(generation),
          state: uri(RV + 'Active'), operation: uri(record.operation), recordedBy: uri(actor), epoch: literal('epoch-one'),
          sequence: literal('4'), head: uri(record.revision), currentState: uri(RV + 'Active'), receipt: uri(record.receipt),
          family: literal(STATEMENT_FAMILIES.record), admission: literal(record.admission), digest: literal(hash(record.statement)),
          authority: literal('7'), scope: literal('statement:write') }]);
      }
      if (query.includes('SELECT ?epoch ?sequence ?head')) return rows([{ epoch: literal('epoch-one'), sequence: literal('9'), head: uri(record!.revision) }]);
      if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows([{ epoch: literal('epoch-one'), sequence: literal('9'),
        context: uri(GLOBAL_CLASSIFICATION_CONTEXT), policy: uri(CLASSIFICATION_ISOLATE_POLICY) }]);
      if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) {
        if (!record) throw new Error('Missing exact adoption selector');
        const adopted = record !== assertion || assertionAdopted;
        return rows([{ statement: uri(record.statement), epoch: literal('epoch-one'), sequence: literal('9'),
          globalSlot: uri(decisionSlotIri({ kind: 'statement', statement: record.statement }, GLOBAL_CLASSIFICATION_CONTEXT)),
          globalDecision: uri(record.decision), globalOutcome: uri(RV + (adopted ? 'Accepted' : 'Rejected')) },
          { statement: uri(record.key), epoch: literal('epoch-one'), sequence: literal('9') }]);
      }
      if (query.includes('SELECT ?manifest ?predecessor')) return rows([{ manifest: uri(occurrenceManifest),
        epoch: literal('epoch-one'), sequence: literal('2'), model: uri(RELATION_V2_PROFILE), generation: uri(generation), operation: uri(id(117)) }]);
      if (query.includes('SELECT ?definition ?manifest')) {
        const isProperty = query.includes(`<${propertyRevision}>`);
        return rows([{ definition: uri(isProperty ? property : definition), manifest: uri(isProperty ? propertyManifest : definitionManifest),
          kind: uri(RV + (isProperty ? 'PropertyDefinition' : 'RelationDefinition')), model: uri(PROFILES.definitionV2) }]);
      }
      if (query.includes('SELECT ?definition ?head')) return rows([{ definition: uri(property), head: uri(propertyRevision) }]);
      if (query.includes('SELECT ?receipt ?admission')) return rows(relationAcknowledged
        ? [{ receipt: uri(relationReceipt), admission: literal(relationAdmission) }] : []);
      if (query.includes('SELECT ?outcome ?reason ?kind')) return rows([{ outcome: uri(RV + 'Succeeded'), digest: literal(hash('relation-request')),
        admissionId: literal(relationAdmission), authorityEpoch: literal('7'), scope: literal('relation:write'),
        sequence: literal('2'), epoch: literal('epoch-one'), component: uri(occurrence), revision: uri(occurrenceRevision) }]);
      if (query.includes('SELECT ?context ?disclosure')) return rows([{ context: uri(id(131)), disclosure: uri(RV + 'Private') }]);
      if (query.includes('ASK')) return { boolean: query.includes('rv:OperationReceipt') ? finalHeadMatches
        : query.includes('rv:occurrenceHead') ? occurrenceActive : true };
      throw new Error(`Unexpected native coverage owner query: ${query.slice(0, 100)}`);
    },
  } } as unknown as WorkActivationEnvironment;
  occurrenceManifest = await sealComponentState(env, occurrence, RELATION_V2_PROFILE, occurrenceState);
  definitionManifest = await sealComponentState(env, definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: 4, ordered: true },
      { key: 'alternate', minParticipants: 1, maxParticipants: 4, ordered: true }], workSubjectRole: 'work',
    association: { kind: 'appearance', workRole: 'work', subjectRoles: ['subject', 'alternate'] },
  }, 'semantic-change-v2'));
  propertyManifest = await sealComponentState(env, property, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'property', roles: [], notation: OCCURRENCE_ASSERTION_NOTATION,
  }, 'semantic-change-v2'));
  for (const record of records) record.manifest = await sealComponentState(env, record.statement, STATEMENT_V2_PROFILE, {
    revision: record.revision, meaning: record.meaning, meaningKey: record.key, speaker: actor,
    semanticContextRevision: privateMeaning && record === trait ? id(130) : null, state: 'active', evidence: [], recordedBy: actor,
    modelGeneration: generation, subjectRdf: semanticValueRdf(record.meaning.subject, () => id(140)),
    valueRdf: semanticValueRdf(record.meaning.value, () => id(141)),
  });
  const work = { environment: env, access: { activePrincipalId: async () => 'principal', canReadSemanticResource: async () => true,
    canReadWork: async () => false }, contextSelections: { canReadPrivate: async () => {
      privateReads++; return privateReadable && (!withdrawPrivateAtCompletion || privateReads === 1);
    } } } as unknown as Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections' | 'relationAttribution'>;
  const input: NativeBasisVerificationInput = { actingSubject: actor, native: { kind: 'statement', owner: 'statement',
    target: subject, statement: trait.statement, revision: trait.revision, receipt: trait.receipt,
    predicate: trait.meaning.predicate, relationDefinition: trait.meaning.relationDefinition, value: trait.meaning.value,
    context: 'global', qualifiers: { applicability: [], interpretationDefinitions: [] }, coverage: trait.meaning.coverage,
    acceptance: { context: GLOBAL_CLASSIFICATION_CONTEXT, decision: trait.decision, source: 'global' } },
    selected: { value: true, language: { state: 'omitted' } } };
  return { work, input, assertion, trait, occurrence, occurrenceRevision, queries,
    assertionVisible: (value: boolean) => { assertionVisible = value; }, assertionAdopted: (value: boolean) => { assertionAdopted = value; },
    occurrenceActive: (value: boolean) => { occurrenceActive = value; }, relationAcknowledged: (value: boolean) => { relationAcknowledged = value; },
    privateReadable: (value: boolean) => { privateReadable = value; }, withdrawPrivateAtCompletion: () => { withdrawPrivateAtCompletion = true; privateReads = 0; },
    finalHeadMatches: (value: boolean) => { finalHeadMatches = value; }, inventory: (value: Row[]) => { inventory = value; } };
}

test('a participation support keeps its own command receipt and independently adopted occurrence assertion', async () => {
  const f = await fixture();
  const verified = await verifyAcknowledgedSemanticBasis(f.work, principal, f.input);
  expect(verified.commandReceipt).toMatchObject({ receipt: f.trait.receipt, admissionId: f.trait.admission,
    operation: f.trait.operation, component: f.trait.statement, revision: f.trait.revision, requestDigest: hash(f.trait.statement),
    authorityEpoch: '7', scope: 'statement:write', dataEpoch: 'epoch-one', sequence: '4' });
  expect(verified.occurrenceAdoption).toMatchObject({ native: { statement: f.assertion.statement,
    coverage: { kind: 'occurrence', occurrence: f.occurrence, occurrenceRevision: f.occurrenceRevision } },
    commandReceipt: { receipt: f.assertion.receipt, admissionId: f.assertion.admission, revision: f.assertion.revision } });
  expect(verified.occurrenceAdoption!.commandReceipt.receipt).not.toBe(verified.receipt);
  expect(verified.native).toEqual(f.input.native);
  expect(f.queries.at(-1)).toContain(`<${f.assertion.statement}> rv:head <${f.assertion.revision}>`);
});

test('a trait adoption cannot replace missing or rejected occurrence adoption or an unacknowledged native occurrence', async () => {
  const f = await fixture();
  expect((await verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).receipt).toBe(f.trait.receipt);
  f.assertionVisible(false);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  f.assertionVisible(true); f.assertionAdopted(false);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  f.assertionAdopted(true); f.relationAcknowledged(false);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  f.relationAcknowledged(true); f.occurrenceActive(false);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
});

test('the same subject in another role cannot replace the exact participation or covered occurrence assertion', async () => {
  const f = await fixture();
  expect((await verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).receipt).toBe(f.trait.receipt);
  if (f.input.native.kind !== 'statement' || f.input.native.coverage?.kind !== 'participation') throw new Error('fixture coverage');
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, { ...f.input, native: { ...f.input.native,
    coverage: { ...f.input.native.coverage, participation: id(122) } } })).rejects.toMatchObject({ code: 'native_value_mismatch', status: 422 });
  f.inventory([{ statement: uri(f.trait.statement), revision: uri(f.trait.revision) }]);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  f.inventory(Array.from({ length: 513 }, () => ({ statement: uri(f.assertion.statement), revision: uri(f.assertion.revision) })));
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
});

test('private meaning authority and the pinned head are checked again before native verification returns', async () => {
  const f = await fixture(true);
  expect((await verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).receipt).toBe(f.trait.receipt);
  f.privateReadable(false);
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  f.privateReadable(true); f.withdrawPrivateAtCompletion();
  await expect(verifyAcknowledgedSemanticBasis(f.work, principal, f.input)).rejects.toMatchObject({ code: 'native_basis_unavailable', status: 503 });
  const current = await fixture(); current.finalHeadMatches(false);
  await expect(verifyAcknowledgedSemanticBasis(current.work, principal, current.input)).rejects.toMatchObject({ code: 'native_head_mismatch', status: 409 });
});
