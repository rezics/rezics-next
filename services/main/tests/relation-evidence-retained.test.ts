import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { readAssociationEvidenceClaim, selectAssociationEvidence } from '../src/modules/relation/evidence.ts';
import { readRetainedAssociationEvidenceOccurrence } from '../src/modules/relation/evidence-retained.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { StatementNotFound } from '../src/modules/statement/read.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { retainedCreditAssociationDigest, RETAINED_CREDIT_ASSOCIATIONS,
  RETAINED_CREDIT_ASSOCIATIONS_PROFILE } from '../src/modules/work/credit-association-state.ts';
import { prepareRetainedCreditBinding } from '../src/modules/work/credit-association-write.ts';
import { WorkReadSession, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const receipt = (key: string) => `urn:rezics:receipt:${hash(key)}`;
const directory = resolve('.temp', `relation-evidence-retained-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const rows = (...values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key,
    { type: /^(https:|urn:)/.test(text) ? 'uri' : 'literal', value: text }])) ) } });

/** Real immutable credit/definition seals and receipt/digest readers, with
 * bounded graph, Source, activation, coverage and disclosure transports. The
 * coverage port is deliberately insufficient to supply a real adopted assertion. */
async function fixture() {
  const credit = id(1), revision = id(2), work = id(3), definition = id(4), definitionRevision = id(5), actor = id(9);
  const admission = id(6).slice(-36), commandReceipt = familyReceiptIri(admission, RETAINED_CREDIT_ASSOCIATIONS);
  const generation = `urn:rezics:model-generation:${hash('generation')}`;
  const live = { sequence: '21', head: revision as string | null, support: 'current' as 'current' | 'withdrawn',
    sourceAvailable: true, readable: true, visible: true, indexed: true, mapping: hash('mapping'), coverage: id(32),
    activated: true, covered: true, ambiguous: false };
  let manifest = '', definitionManifest = '';
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' },
    fuseki: { query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      if (query.includes('SELECT ?head WHERE')) return live.ambiguous ? rows({ head: revision }, { head: id(90) })
        : live.indexed ? rows({ head: revision }) : rows();
      if (query.includes('SELECT ?epoch ?routing ?sequence')) return rows({ epoch: 'epoch-one', routing: '1', sequence: live.sequence });
      if (query.includes('SELECT ?generation WHERE')) return rows({ generation });
      if (query.includes('SELECT ?manifest ?number')) return rows({ manifest: `urn:rezics:sha256:${hash('model')}`, number: '1',
        entailment: RV + 'NoEntailment', digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: hash('generation') })) });
      if (query.includes('SELECT ?manifest ?predecessor ?receipt')) return rows({ manifest, work, creditRevision: id(7),
        receipt: commandReceipt, admission, scope: `work:edit:${work}`, epoch: 'epoch-one', sequence: '12',
        digest: retainedCreditAssociationDigest(state, null), operation: id(8), receiptOperation: id(8), modelGeneration: generation });
      if (query.includes('SELECT ?associationHead WHERE')) return live.head ? rows({ associationHead: live.head }) : rows();
      if (query.includes('SELECT ?definition ?manifest')) return rows({ definition, manifest: definitionManifest,
        kind: RV + 'RelationDefinition', model: PROFILES.definitionV2 });
      if (query.includes('SELECT ?operation ?generation')) return rows({ operation: id(8), generation });
      if (query.includes('SELECT DISTINCT ?statement ?revision')) return rows();
      if (query.includes('ASK')) return { boolean: true };
      throw new Error(`Unexpected retained evidence owner query: ${query.slice(0, 110)}`);
    } } } as unknown as WorkActivationEnvironment;
  const binding = await prepareRetainedCreditBinding(env, { credit, creditRevision: id(7), work, workRevision: id(11),
    retainedProfile: 'source-reported-credit-v1', role: 'author', expectedAssociationHead: null,
    origin: { kind: 'source-binding', binding: id(10), proposal: id(15), conversion: id(12),
      record: id(13), observation: id(14), sourceOccurrence: `urn:rezics:source-occurrence:${hash('/authors/3')}`, sourceOrdinal: 3 },
    mapping: { revision: definitionRevision, definition, workRole: `${definition}/role/work`,
      subjectRole: `${definition}/role/subject`, originProfile: 'source-reported-credit-v1', originRole: 'author',
      externalNamespace: { provider: 'openlibrary', namespace: 'author' } },
    subject: { participant: { kind: 'external', provider: 'openlibrary', namespace: 'author', key: 'OL42A' },
      position: 3, attributionSupports: [] } });
  const state = binding.state;
  manifest = await sealComponentState(env, credit, RETAINED_CREDIT_ASSOCIATIONS_PROFILE, state);
  definitionManifest = await sealComponentState(env, definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: true }], workSubjectRole: 'work',
    association: { kind: 'credit', workRole: 'work', subjectRoles: ['subject'] },
    retainedCredit: { origin: 'source-reported-credit-v1', storedRole: 'author', subjectRole: 'subject',
      externalNamespace: { provider: 'openlibrary', namespace: 'author' } },
  }, 'semantic-change-v2'));
  const deps: MainWorkDependencies = { environment: env,
    access: { assertRecoveryOpen: async () => {}, canReadWork: async () => live.readable },
    retainedCreditRelations: { reads: {
      activation: async () => live.activated ? { profile: RETAINED_CREDIT_ASSOCIATIONS, generation,
        revision: id(30), receipt: receipt('activation'), coverageRevision: id(31), coverageReceipt: receipt('inventory'), complete: true } : null,
      mapping: async () => ({ mapping: state.mapping, generation, receipt: receipt('mapping'), validationToken: live.mapping }),
      coverage: async () => live.covered ? { state: 'covered', generation, revision: live.coverage, receipt: receipt('coverage'),
        adoption: id(33), complete: true, statements: [{ statement: id(34), revision: id(35), decisionRevision: id(36) }] } : null,
      origin: async () => live.sourceAvailable ? { credit, creditRevision: state.creditRevision, work, workRevision: state.workRevision,
        role: state.role, retainedProfile: state.retainedProfile, origin: structuredClone(state.origin),
        participations: structuredClone(state.participations), receipt: receipt('source-command'),
        validation: [{ basis: { kind: 'source-binding', binding: id(10) }, state: live.support, receipt: receipt('source-command'),
          validationToken: hash(live.support), fields: {}, evidence: [] }] } : null,
    } },
  } as unknown as MainWorkDependencies;
  const session = (cursor?: string, authenticated = true) => {
    const read = new WorkReadSession(deps, new Request('http://test/v1/relations/one?position=start'),
      { ...(authenticated ? { actingSubject: actor } : {}), cursor }, { dataEpoch: 'epoch-one', sequence: live.sequence });
    if (authenticated) read.principal = { issuer: 'https://account.test', subject: 'verified-editor' };
    read.disclosure = async targets => {
      const check = async () => targets.map(() => live.visible ? 'visible' as const : 'hidden' as const);
      const value = await check();
      read.observeDependency('controlled-disclosure', value, check);
      return value;
    };
    return read;
  };
  return { state, revision, commandReceipt, generation, manifest, live, deps, session, queries };
}

test('retained evidence resolves the original credit and exact owner receipt without creating another occurrence', async () => {
  const f = await fixture(), before = structuredClone(f.state), session = f.session();
  const owned = await readRetainedAssociationEvidenceOccurrence(session, f.state.credit, f.revision);
  expect({ kind: owned?.kind, occurrence: owned?.occurrence, associationHead: owned?.associationHead,
    currentAssociationHead: owned?.currentAssociationHead, receipt: owned?.receipt, manifest: owned?.manifest,
    operation: owned?.operation, modelGeneration: owned?.modelGeneration }).toEqual({
    kind: 'retained-credit', occurrence: f.state.credit, associationHead: f.revision,
    currentAssociationHead: f.revision, receipt: f.commandReceipt, manifest: f.manifest, operation: id(8), modelGeneration: f.generation });
  expect(owned!.state.participations).toEqual(f.state.participations);
  expect(owned!.publicView?.coverage.revision).toBe(f.live.coverage);
  expect(owned!.publicView?.mappingValidation.validationToken).toBe(f.live.mapping);
  expect(owned!.currentPosition.sequence).toBe('21');
  expect(owned!.sourcePosition.sequence).toBe('12');
  await session.fenceDependencies();
  expect(f.state).toEqual(before);
  expect(f.queries.some(query => query.includes('INSERT') || query.includes('DELETE'))).toBe(false);
});

test('a current compatibility view cannot replace its missing independent occurrence adoption', async () => {
  const f = await fixture();
  const selection = selectAssociationEvidence(f.state.credit, f.revision, { profile: 'association-evidence-v1', context: 'global',
    position: 'start', claim: f.state.credit, claimRevision: f.revision });
  await expect(readAssociationEvidenceClaim(f.session(), selection)).rejects.toBeInstanceOf(StatementNotFound);
  expect(f.queries.some(query => query.includes('SELECT DISTINCT ?statement ?revision'))).toBe(true);
});

test('withdrawn origin, missing public coverage or activation is unavailable, never an adopted empty view', async () => {
  const f = await fixture();
  for (const change of [() => { f.live.support = 'withdrawn'; }, () => { f.live.sourceAvailable = false; },
    () => { f.live.activated = false; }, () => { f.live.covered = false; }, () => { f.live.ambiguous = true; }]) {
    change();
    await expect(readRetainedAssociationEvidenceOccurrence(f.session(), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadUnavailable);
    f.live.support = 'current'; f.live.sourceAvailable = true; f.live.activated = true; f.live.covered = true; f.live.ambiguous = false;
  }
});

test('current Source, mapping, coverage and disclosure are revalidated through final emission', async () => {
  const f = await fixture();
  for (const change of [() => { f.live.support = 'withdrawn'; }, () => { f.live.mapping = hash('replacement'); },
    () => { f.live.coverage = id(90); }, () => { f.live.visible = false; }, () => { f.live.readable = false; },
    () => { f.live.head = id(91); }]) {
    const session = f.session();
    await readRetainedAssociationEvidenceOccurrence(session, f.state.credit, f.revision);
    change();
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
    f.live.support = 'current'; f.live.mapping = hash('mapping'); f.live.coverage = id(32);
    f.live.visible = true; f.live.readable = true; f.live.head = f.revision;
  }
});

test('exact replacement selection, denied reads and absent anonymous owners never borrow a different reader or head', async () => {
  const f = await fixture();
  f.live.head = id(90);
  await expect(readRetainedAssociationEvidenceOccurrence(f.session(), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readRetainedAssociationEvidenceOccurrence(f.session('opaque-cursor'), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadMoved);
  f.live.head = f.revision; f.live.readable = false;
  await expect(readRetainedAssociationEvidenceOccurrence(f.session(), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadMissing);
  f.live.readable = true; f.live.visible = false;
  await expect(readRetainedAssociationEvidenceOccurrence(f.session(undefined, false), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadMissing);
  f.live.visible = true;
  await expect(readRetainedAssociationEvidenceOccurrence(f.session(undefined, false), f.state.credit, f.revision)).rejects.toBeInstanceOf(WorkReadUnavailable);
  f.live.indexed = false;
  expect(await readRetainedAssociationEvidenceOccurrence(f.session(), f.state.credit, f.revision)).toBeNull();
});
