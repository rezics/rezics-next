import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { nativeAssociationCandidates, readNativeAssociationPage } from '../src/modules/query/association-native.ts';
import { selectAssociations } from '../src/modules/query/association-selection.ts';
import { RELATION_CHANGE_FAMILY } from '../src/modules/relation/change.ts';
import { checkedAttributionSupports, RELATION_V2_PROFILE } from '../src/modules/relation/v2-schema.ts';
import { ASSOCIATION_QUERY } from '../src/modules/query/association-contract.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import { resolveStatementCoverage } from '../src/modules/statement/v2-coverage.ts';
import type { StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { systemDisclosure } from '../src/modules/target/disclosed-references.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { commandReceiptIri } from '../src/modules/context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../src/modules/classification/context.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { semanticValueRdf } from '../src/modules/semantic/value.ts';
import { STATEMENT_FAMILIES } from '../src/modules/statement/receipt-family.ts';
import { decisionSlotIri } from '../src/modules/statement/schema.ts';
import { OCCURRENCE_ASSERTION_NOTATION, STATEMENT_V2_PROFILE, statementMeaningKeyV2 } from '../src/modules/statement/v2-schema.ts';
import type { WikiEvidenceRow } from '../src/modules/wiki/evidence.ts';
import { retainedCreditAssociationDigest, RETAINED_CREDIT_ASSOCIATIONS,
  RETAINED_CREDIT_ASSOCIATIONS_PROFILE } from '../src/modules/work/credit-association-state.ts';
import { prepareRetainedCreditBinding } from '../src/modules/work/credit-association-write.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import { nativeCreditStatementCoverage, readNativeCreditAssociation, readNativeCreditAttribution } from '../src/modules/work/native-association.ts';
import { readNativeCreditAttributionProof } from '../src/modules/work/credit-attribution.ts';
import type { RelationAttributionProof } from '../src/modules/relation/attribution.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (...values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key,
    { type: /^(https:|urn:)/.test(text) ? 'uri' : 'literal', value: text }])) ) } });
const directory = resolve('.temp', `native-associations-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const selection = selectAssociations({ profile: 'template-query-v1', query: ASSOCIATION_QUERY, revision: 1,
  parameters: { kind: 'credit', direction: 'work-to-subject', projection: 'occurrence', context: 'global',
    frame: [], position: 'start', match: { role: `${id(4)}/role/subject`, all: [], any: [], none: [] } }, limit: 1 });

/** Actual immutable native tuple/credit seals and exact Definition decoding;
 * bounded graph transports are controlled doubles. These tests manufacture no
 * installed model, global activation, adoption or runtime acceptance receipt. */
async function fixture(agent = true, version = 1, attributed = false, multipleSubjects = false, nativeAnnotation = false) {
  const credit = id(1), revision = id(2), work = id(3), definition = id(4), definitionRevision = id(5);
  const commandAdmission = id(6).slice(-36), originalAdmission = id(12).slice(-36);
  const generation = `urn:rezics:model-generation:${hash('native-generation')}`;
  const role = version === 2 ? 'performer' as const : 'artist' as const;
  const live = { head: null as string | null, original: true, mapping: true, metadata: true, guarded: true,
    sequence: '21', model: `https://rezics.com/definition/${agent ? 'native-agent' : 'work-author'}-credit-v${version}`,
    candidates: [] as Record<string, string>[], queries: [] as string[] };
  let manifest = '', definitionManifest = '';
  const digest = nativeCreditDigest({ credit, work, expectedWorkHead: id(9), actingSubject: id(10), role,
    ...(agent ? { agent: id(11) } : { participant: { kind: 'external-reference' as const,
      provider: 'native', namespace: 'person', key: 'same-key' }, ordinal: 3 }) });
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: { query: async (query: string): Promise<SparqlResult> => {
      live.queries.push(query);
      if (query.includes('SELECT ?revision ?kind')) return rows({ revision: id(12), kind: RV + (agent ? 'NativeAgentCredit' : 'AuthorCredit') });
      if (query.includes('SELECT ?work ?head ?agent') || query.includes('SELECT ?work ?head ?key')) return rows({
        work, head: id(9), ...(agent ? { agent: id(11), role }
          : { key: 'same-key', provider: 'native', namespace: 'person', creditRole: role, ordinal: '3' }),
        actor: id(10), epoch: 'epoch', sequence: '10', model: live.model, shape: live.model,
        ...(version === 2 ? { currentModel: live.model } : {}),
      });
      if (query.includes('SELECT DISTINCT ?receipt ?admission')) return live.original ? rows({
        receipt: workEditReceiptIri(originalAdmission), admission: originalAdmission, nativeCommand: 'true' }) : rows();
      if (query.includes('SELECT ?outcome ?reason')) return rows({ outcome: RV + 'Succeeded', digest,
        admissionId: originalAdmission, authorityEpoch: '7', scope: `work:edit:${work}`,
        epoch: 'epoch', sequence: '10', work, revision: id(9), predecessor: id(9) });
      if (query.includes('SELECT DISTINCT ?credit ?revision ?intent')) return rows({ credit, revision: id(12), intent: credit });
      if (query.includes('SELECT ?workHead ?creditHead')) return rows({ workHead: id(9), creditHead: id(12), epoch: 'epoch', routing: '1' });
      if (query.includes('SELECT ?associationHead')) return live.head ? rows({ associationHead: live.head }) : rows();
      if (query.includes('SELECT ?manifest ?predecessor ?receipt')) return rows({ manifest, work, creditRevision: id(12),
        receipt: familyReceiptIri(commandAdmission, RETAINED_CREDIT_ASSOCIATIONS), admission: commandAdmission,
        scope: `work:edit:${work}`, epoch: 'epoch', sequence: '12', digest: retainedCreditAssociationDigest(state, null),
        ...(live.metadata ? { operation: id(13), receiptOperation: id(13), modelGeneration: generation } : {}) });
      if (query.includes('SELECT ?definition ?manifest')) return rows({ definition: live.mapping ? definition : id(99),
        manifest: definitionManifest, kind: RV + 'RelationDefinition', model: PROFILES.definitionV2 });
      if (query.includes('SELECT DISTINCT ?work ?occurrence')) return rows(...live.candidates);
      if (query.includes('ASK')) return { boolean: live.guarded };
      if (query.includes('a rv:RelationOccurrenceRevision')) return rows();
      if (query.includes('SELECT ?generation')) return rows({ generation });
      if (query.includes('SELECT ?manifest ?number')) return rows({ manifest: `urn:rezics:sha256:${hash('model')}`,
        number: '1', entailment: RV + 'NoEntailment', digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: hash('native-generation') })) });
      throw new Error(`Unexpected native owner query: ${query.slice(0, 160)}`);
    } } } as unknown as WorkActivationEnvironment;
  const binding = await prepareRetainedCreditBinding(env, { credit, creditRevision: id(12), work, workRevision: id(9),
    retainedProfile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1', role, expectedAssociationHead: null,
    origin: { kind: 'stored-credit', revision: id(12) }, mapping: { revision: definitionRevision, definition,
      workRole: `${definition}/role/work`, subjectRole: `${definition}/role/subject`,
      originProfile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1', originRole: role,
      externalNamespace: null },
    subject: { participant: agent ? { kind: 'resource', ref: id(11) }
      : { kind: 'external', provider: 'native', namespace: 'person', key: 'same-key' },
      ...(agent ? {} : { position: 3 }), ...(attributed ? {
        creditedName: { lexical: 'Exact credited alias', language: 'ja' },
        sourceIdentity: { ...(nativeAnnotation ? { provider: 'native', namespace: 'person', key: 'same-key' }
          : { provider: 'original', namespace: 'persons', key: 'different-key' }), alias: 'Alias', eid: '0042', note: 'Exact source note' },
        attributionSupports: [{ basis: nativeAnnotation ? { kind: 'native-credit', credit, revision: id(12) }
          : { kind: 'source-credit', support: id(180) }, evidence: [id(181)],
          fields: ['creditedName', 'provider', 'namespace', 'key', 'alias', 'eid', 'note'] }],
      } : { attributionSupports: [] }) } });
  const state = binding.state;
  manifest = await sealComponentState(env, credit, RETAINED_CREDIT_ASSOCIATIONS_PROFILE, state);
  definitionManifest = await sealComponentState(env, definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: multipleSubjects ? 2 : 1, ordered: !agent }], workSubjectRole: 'work',
    association: { kind: 'credit', workRole: 'work', subjectRoles: ['subject'] },
    retainedCredit: { origin: state.retainedProfile, storedRole: role, subjectRole: 'subject' },
  }, 'semantic-change-v2'));
  live.head = revision;
  const deps = { environment: env, access: {} } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://test/v1/query'), {}, { dataEpoch: 'epoch', sequence: live.sequence });
  const meaning: StatementMeaningV2 = { subject: state.participations[1]!.participant, predicate: id(20), relationDefinition: id(21),
    value: { kind: 'string', lexical: 'original trait' }, applicability: [], interpretationDefinitions: [],
    coverage: { kind: 'participation', occurrence: credit, occurrenceRevision: revision, participation: state.subjectParticipation } };
  return { env, live, state, session, meaning, revision, generation };
}

test('native identity resolves both activated native families and V1/V2 profiles without retained activation', async () => {
  for (const agent of [true, false]) for (const version of [1, 2]) {
    const f = await fixture(agent, version), native = await readNativeCreditAssociation(f.session(), f.state.credit);
    expect(native?.revision).toBe(f.revision);
    expect(native?.state.participations).toEqual(f.state.participations);
    expect(native?.original.value.modelRevision).toBe(version === 2 ? f.live.model : undefined);
    expect(native?.guard).toContain('rv:creditRevision');
    expect(f.live.queries.some(query => /activation|coverageReceipt|complete/.test(query))).toBe(false);
  }
});

test('native seal identity refuses absent allocations, actual original receipts, stale heads and missing command metadata', async () => {
  const f = await fixture();
  f.live.head = null;
  await expect(readNativeCreditAssociation(f.session(), f.state.credit)).rejects.toThrow('participation allocations');
  f.live.head = f.revision; f.live.original = false;
  await expect(readNativeCreditAssociation(f.session(), f.state.credit)).rejects.toThrow();
  f.live.original = true;
  await expect(readNativeCreditAssociation(f.session(), f.state.credit, id(50))).rejects.toThrow(WorkReadMoved);
  f.live.metadata = false;
  await expect(readNativeCreditAssociation(f.session(), f.state.credit)).rejects.toThrow('command metadata');
  f.live.metadata = true; f.live.mapping = false;
  await expect(readNativeCreditAssociation(f.session(), f.state.credit)).rejects.toThrow();
});

test('exact native coverage reuses real immutable allocations and refuses a co-participant, provider collision and hidden Work', async () => {
  const f = await fixture(false), session = f.session();
  const read = (occurrence: string, revision: string) => nativeCreditStatementCoverage(session, occurrence, revision);
  const covered = await resolveStatementCoverage(f.env, f.meaning, async () => true, async () => true,
    systemDisclosure, undefined, undefined, read);
  expect(covered.native?.modelGeneration).toBe(f.generation);
  expect(covered.references).toContain(f.state.subjectParticipation);
  for (const meaning of [{ ...f.meaning, subject: { kind: 'resource' as const, ref: f.state.work } },
    { ...f.meaning, subject: { kind: 'external' as const, provider: 'different', namespace: 'person', key: 'same-key' } },
    { ...f.meaning, coverage: { ...f.meaning.coverage, participation: f.state.workParticipation } }]) {
    await expect(resolveStatementCoverage(f.env, meaning, async () => true, async () => true,
      systemDisclosure, undefined, undefined, read)).rejects.toThrow();
  }
  await expect(resolveStatementCoverage(f.env, f.meaning, async ref => ref !== f.state.work, async () => true,
    systemDisclosure, undefined, undefined, read)).rejects.toThrow();
  f.live.guarded = false;
  await expect(resolveStatementCoverage(f.env, f.meaning, async () => true, async () => true,
    systemDisclosure, undefined, undefined, read)).rejects.toThrow();
});

test('visitor native attribution reads the actual original receipt and current qualified tuple without an invented principal', async () => {
  const f = await fixture(false), native = (await readNativeCreditAssociation(f.session(), f.state.credit))!;
  const participations = native.state.participations.map(({ id: _id, ...part }) => part);
  const participation = participations[1]!;
  const support = { basis: { kind: 'native-credit' as const, credit: f.state.credit, revision: f.state.creditRevision },
    fields: ['provider', 'namespace', 'key'] as ('provider' | 'namespace' | 'key')[], evidence: [] };
  const proof = await readNativeCreditAttributionProof(f.env, native.definition, participations, { participation, support });
  expect(proof?.proof).toMatchObject({ receipt: native.original.receipt.receipt, revision: f.state.creditRevision,
    participant: participation.participant, state: 'current', evidence: [],
    fields: { provider: 'native', namespace: 'person', key: 'same-key' } });
  expect(Object.keys(proof!.proof.fields).sort()).toEqual(['key', 'namespace', 'provider']);
  expect(proof!.guard).toContain('rv:creditRevision');
  expect(await readNativeCreditAttributionProof(f.env, native.definition, participations, { participation,
    support: { ...support, basis: { ...support.basis, revision: id(199) } } })).toBeNull();
  expect(await readNativeCreditAttributionProof(f.env, native.definition, participations, { participation: {
    ...participation, participant: { kind: 'external', provider: 'collision', namespace: 'person', key: 'same-key' },
  }, support })).toBeNull();
  f.live.original = false;
  await expect(readNativeCreditAttributionProof(f.env, native.definition, participations, { participation, support }))
    .rejects.toThrow('original credit command receipt');
});

test('ordered primary inventory includes native credits without importing Source conversion or omitting V1 commands', async () => {
  const f = await fixture(), session = f.session();
  f.live.candidates = [{ work: id(3), occurrence: id(1), revision: id(2), family: 'credit' },
    { work: id(3), occurrence: id(40), revision: id(41), subjectParticipation: id(42), family: 'relation' },
    { work: id(3), occurrence: id(50), revision: id(51), subjectParticipation: id(52), family: 'relation' }];
  const page = await nativeAssociationCandidates(session, selection, null, 64);
  expect(page.items.map(item => item.family)).toEqual(['credit', 'relation']);
  expect(page.more).toBe(true);
  const query = f.live.queries.at(-1)!;
  expect(query).toContain('VALUES ?nativeCreditKind { rv:AuthorCredit rv:NativeAgentCredit }');
  expect(query).toContain('rv:associationHead ?revision');
  expect(query).not.toContain('OPTIONAL { ?occurrence rv:associationHead');
  expect(query).not.toContain('SourceReportedCredit');
  expect(query).not.toContain('coverageReceipt');
  await nativeAssociationCandidates(session, selection, { kind: 'matches', key: page.items[1]! }, 64);
  expect(f.live.queries.at(-1)).toContain(`FILTER(?work = <${id(3)}>)`);
  expect(f.live.queries.at(-1)).toContain(`STR(?subjectParticipation) > "${id(42)}"`);
});

test('hidden native candidates retain a bounded physical continuation and cannot fabricate complete empty success', async () => {
  const f = await fixture(), session = f.session();
  f.live.candidates = [1, 2, 3].map(n => ({ work: id(30), occurrence: id(40 + n), revision: id(50 + n), family: 'credit' }));
  session.summaries = async resources => resources.map(reference => ({ reference, status: 'unavailable' as const }));
  const page = await readNativeAssociationPage(session, selection, 'query');
  expect(page.items).toEqual([]);
  expect(page.complete).toBe(false);
  expect(page.nextCursor).toBeString();
  expect(f.live.queries.some(query => query.includes('SELECT ?revision ?kind'))).toBe(false);
  await expect(nativeAssociationCandidates(session, selection, null, 0)).rejects.toThrow(WorkReadUnavailable);
});

async function publishedFixture(relation = false, attributed = false, sibling = false, nativeAnnotation = false) {
  const f = await fixture(!nativeAnnotation, 1, attributed, sibling, nativeAnnotation), originalQuery = f.env.fuseki.query.bind(f.env.fuseki);
  const occurrenceAdmission = id(172).slice(-36), occurrenceReceipt = familyReceiptIri(occurrenceAdmission, RELATION_CHANGE_FAMILY);
  const occurrenceManifest = relation ? await sealComponentState(f.env, f.state.credit, RELATION_V2_PROFILE, {
    profile: 'relation-change-v2', definition: f.state.mapping.revision, lifecycle: 'active', applicability: [],
    participations: [...f.state.participations.map(({ id: iri, ...part }) => ({ ...part, iri,
      attributionSupports: checkedAttributionSupports(part.attributionSupports) })), ...(sibling ? [{
      iri: id(185), role: `${f.state.mapping.definition}/role/subject`, participant: { kind: 'resource', ref: id(184) },
      attributionSupports: [],
    }] : [])], attributionProofs: f.state.participations.flatMap(part => part.attributionSupports.map(support => ({
      participation: part.id, proof: { basis: support.basis, receipt: `urn:rezics:receipt:${hash('original-source-citation')}`,
        revision: id(182), validationToken: hash('original-source-support'), state: 'current', participant: part.participant,
        fields: { creditedName: part.creditedName, ...part.sourceIdentity }, evidence: support.evidence },
    }))),
  }) : null;
  const records = [
    { statement: id(100), revision: id(101), meaning: { subject: { kind: 'resource', ref: f.state.credit },
      predicate: id(20), relationDefinition: id(21), value: { kind: 'resource', ref: f.revision }, applicability: [],
      interpretationDefinitions: [], coverage: { kind: 'occurrence', occurrence: f.state.credit, occurrenceRevision: f.revision } } as StatementMeaningV2 },
    { statement: id(102), revision: id(103), meaning: f.meaning },
    { statement: id(104), revision: id(105), meaning: { ...f.meaning, coverage: { kind: 'subject-global' } } as StatementMeaningV2 },
    ...(sibling ? [{ statement: id(186), revision: id(187), meaning: { ...f.meaning,
      subject: { kind: 'resource', ref: id(184) }, value: { kind: 'string', lexical: 'other subject trait' },
      coverage: { kind: 'participation', occurrence: f.state.credit, occurrenceRevision: f.revision, participation: id(185) },
    } as StatementMeaningV2 }] : []),
  ].map((record, index) => ({ ...record, operation: id(110 + index), admission: id(120 + index).slice(-36),
    receipt: commandReceiptIri(id(120 + index).slice(-36), STATEMENT_FAMILIES.record), decision: id(130 + index),
    key: statementMeaningKeyV2(record.meaning), manifest: '', evidence: id(140 + index) }));
  const [assertion] = records;
  const live = { adopted: true, visible: true, quote: true };
  const propertyManifest = await sealComponentState(f.env, id(20), PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'property', roles: [], notation: OCCURRENCE_ASSERTION_NOTATION,
  }, 'semantic-change-v2'));
  for (const record of records) record.manifest = await sealComponentState(f.env, record.statement, STATEMENT_V2_PROFILE, {
    revision: record.revision, meaning: record.meaning, meaningKey: record.key, speaker: id(10), semanticContextRevision: null,
    state: 'active', evidence: [record.evidence], recordedBy: id(10), modelGeneration: f.generation,
    subjectRdf: semanticValueRdf(record.meaning.subject, () => id(150)), valueRdf: semanticValueRdf(record.meaning.value, () => id(151)),
  });
  const references = (query: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'u')
    .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
  f.env.fuseki.query = async query => {
    const record = records.find(item => query.includes(`<${item.statement}>`));
    if (relation && query.includes('SELECT ?manifest ?predecessor ?epoch ?sequence ?model')) return rows({
      manifest: occurrenceManifest!, epoch: 'epoch', sequence: '12', model: RELATION_V2_PROFILE,
      generation: f.generation, operation: id(170) });
    if (relation && query.includes('SELECT ?receipt ?admission')) return rows({ receipt: occurrenceReceipt, admission: occurrenceAdmission });
    if (relation && query.includes('SELECT ?outcome ?reason ?kind')) return rows({ outcome: RV + 'Succeeded',
      digest: hash('native-relation-command'), admissionId: occurrenceAdmission, authorityEpoch: '7', scope: 'relation:write',
      epoch: 'epoch', sequence: '12', component: f.state.credit, revision: f.revision });
    if (query.includes('SELECT DISTINCT ?statement ?revision')) {
      f.live.queries.push(query);
      return query.includes('rv:statementCoverage rv:OccurrenceCoverage')
        ? rows({ statement: assertion!.statement, revision: assertion!.revision })
        : rows(...records.slice(1).filter(item => !sibling || !query.includes('rv:coveredParticipation')
          || item.meaning.coverage.kind === 'subject-global'
          || item.meaning.coverage.kind === 'participation' && query.includes(`<${item.meaning.coverage.participation}>`))
          .map(item => ({ statement: item.statement, revision: item.revision })));
    }
    if (query.includes('SELECT ?manifest ?model ?generation')) {
      if (!record) throw new Error('missing exact native Statement snapshot');
      return rows({ manifest: record.manifest, model: STATEMENT_V2_PROFILE, generation: f.generation, state: RV + 'Active',
        operation: record.operation, recordedBy: id(10), epoch: 'epoch', sequence: '15', head: record.revision,
        currentState: RV + 'Active', receipt: record.receipt, family: STATEMENT_FAMILIES.record,
        admission: record.admission, digest: hash(record.statement), authority: '7', scope: 'statement:write' });
    }
    if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows({ epoch: 'epoch', sequence: f.live.sequence,
      context: GLOBAL_CLASSIFICATION_CONTEXT, policy: CLASSIFICATION_ISOLATE_POLICY });
    if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) {
      if (!record) throw new Error('missing exact native Statement adoption');
      return rows({ statement: record.statement, epoch: 'epoch', sequence: f.live.sequence,
        globalSlot: decisionSlotIri({ kind: 'statement', statement: record.statement }, GLOBAL_CLASSIFICATION_CONTEXT),
        globalDecision: record.decision, globalOutcome: RV + (record === assertion && !live.adopted ? 'Rejected' : 'Accepted') },
      { statement: record.key, epoch: 'epoch', sequence: f.live.sequence });
    }
    if (query.includes('SELECT ?definition ?manifest') && query.includes(`<${id(21)}>`)) return rows({
      definition: id(20), manifest: propertyManifest, kind: RV + 'PropertyDefinition', model: PROFILES.definitionV2 });
    if (query.includes('SELECT ?definition ?head')) return rows({ definition: id(20), head: id(21) });
    if (query.includes('SELECT ?statement WHERE')) return rows({ statement: record!.statement });
    if (query.includes('SELECT ?resource ?head')) return rows(...references(query, 'resource').map(resource => ({ resource, head: id(9) })));
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const result = rows(...references(query, 'r').map(r => ({ epoch: 'epoch', sequence: f.live.sequence,
        r, type: 'work', work: r, head: id(9), label: 'Native visible label', public: 'true', erased: 'false' })));
      for (const row of result.results!.bindings) row.label = { ...row.label!, 'xml:lang': 'en' };
      return result;
    }
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return rows(...references(query, 'r').map(r => ({
      epoch: 'epoch', sequence: f.live.sequence, r, revision: id(9), type: 'https://schema.org/CreativeWork' })));
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) return rows(...references(query, 'work').map(work => ({
      work, head: id(9), owningWork: work, owningHead: id(9) })));
    if (query.includes('SELECT ?epoch ?sequence')) return rows({ epoch: 'epoch', sequence: f.live.sequence });
    return originalQuery(query);
  };
  configureFixtureDisclosureAncestry(f.env, target => target.work
    ? { resource: target.work, head: id(9), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(f.env, fixtureDisclosureReader(async targets => targets.map(target =>
    !live.visible && records.some(record => target.resource === record.statement) ? 'hidden' : 'visible')));
  const session = f.session(), deps = session.deps;
  deps.access = { canReadSemanticResource: async () => true } as unknown as MainWorkDependencies['access'];
  const evidence: WikiEvidenceRow[] = records.map(record => ({ id: record.evidence, claim: record.statement, claimKind: 'statement',
    sourceWork: id(160), representationSha256: hash(record.evidence), locator: { page: 3 }, quote: 'Native manual citation',
    method: { kind: 'manual' }, modality: 'asserted', submitter: id(10), rightsBasis: 'quotation' }));
  deps.wikiEvidence = { forClaims: async (claims: readonly string[], kind: string) => evidence.filter(row =>
    kind === row.claimKind && claims.includes(row.claim!)), withheld: async () => new Set(live.quote ? [] : evidence.map(row => row.id)),
  } as unknown as MainWorkDependencies['wikiEvidence'];
  f.live.candidates = [{ work: f.state.work, occurrence: f.state.credit, revision: f.revision,
    ...(relation ? { subjectParticipation: f.state.subjectParticipation } : {}), family: relation ? 'relation' : 'credit' }];
  return { ...f, records, livePublication: live, session };
}

test('native primary page projects its own adopted occurrence, participation and subject-global traits without conversion', async () => {
  const f = await publishedFixture();
  const page = await readNativeAssociationPage(f.session, selection, 'query');
  expect(page.complete).toBe(true);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ occurrence: f.state.credit, revision: f.revision,
    workParticipation: f.state.workParticipation, subjectParticipation: f.state.subjectParticipation,
    subject: f.state.participations[1]!.participant, citations: [{ id: f.records[0]!.evidence }],
    statements: [{ id: f.records[1]!.statement, decisionRevision: f.records[1]!.decision, occurrence: f.state.credit },
      { id: f.records[2]!.statement, decisionRevision: f.records[2]!.decision, occurrence: null }] });
  expect(f.live.queries.some(query => /coverageReceipt|activation/.test(query))).toBe(false);
  await f.session.fenceDependencies();
  f.livePublication.quote = false;
  await expect(f.session.fenceDependencies()).rejects.toThrow(WorkReadMoved);
});

test('a native trait decision cannot adopt its missing occurrence assertion or disclose hidden native claims', async () => {
  const f = await publishedFixture();
  f.livePublication.adopted = false;
  const rejected = await readNativeAssociationPage(f.session, selection, 'query');
  expect(rejected.items).toEqual([]);
  const hidden = await publishedFixture(); hidden.livePublication.visible = false;
  expect((await readNativeAssociationPage(hidden.session, selection, 'query')).items).toEqual([]);
});

test('inverse native relation survives more than 800 unrelated and unallocated scalar native credits', async () => {
  const f = await publishedFixture(true), graphQuery = f.env.fuseki.query.bind(f.env.fuseki);
  const scalars = Array.from({ length: 803 }, (_, n) => ({ work: id(0), occurrence: id(200 + n),
    family: 'credit', subject: n % 2 ? id(11) : id(190) }));
  const native = { ...f.live.candidates[0]!, subject: id(11) };
  f.env.fuseki.query = async query => {
    if (!query.includes('SELECT DISTINCT ?work ?occurrence')) return graphQuery(query);
    // Controlled graph transport retains actual scalar-versus-participation
    // membership and full root filtering. The old optional-head selector puts
    // scalar rows first and fails before reaching the genuine native tail.
    const allocatedOnly = /rv:creditRevision \?creditRevision\s*;\s*rv:associationHead \?revision/u.test(query);
    const exactRoot = query.includes(`?occurrence rv:agent <${id(11)}>`)
      && query.includes(`?subjectParticipation rv:participant <${id(11)}>`);
    const admitted = [...scalars, native].filter(row => (!allocatedOnly || 'revision' in row)
      && (!exactRoot || row.subject === id(11)));
    return rows(...admitted.slice(0, 3).map(({ subject: _subject, ...row }) => row));
  };
  const inverse = selectAssociations({ ...selection, parameters: { ...selection.parameters,
    direction: 'subject-to-work', roots: [{ kind: 'resource', ref: id(11) }], projection: 'work' } });
  const page = await readNativeAssociationPage(f.session, inverse, 'query');
  expect(page.complete).toBe(true);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ work: f.state.work, matches: { complete: true,
    items: [{ occurrence: f.state.credit, revision: f.revision, subjectParticipation: f.state.subjectParticipation,
      subject: { kind: 'resource', ref: id(11) } }] } });
  expect(f.live.queries.some(query => query.includes('SELECT ?revision ?kind'))).toBe(false);
});

test('inverse external native inventory selects the complete provider, namespace and key before owner hydration', async () => {
  const f = await fixture(false), inverse = selectAssociations({ ...selection, parameters: { ...selection.parameters,
    direction: 'subject-to-work', roots: [{ kind: 'external', provider: 'native', namespace: 'person', key: 'same-key' }] } });
  await nativeAssociationCandidates(f.session(), inverse, null, 64);
  const query = f.live.queries.at(-1)!;
  expect(query).toContain('?occurrence rv:externalProvider "native"');
  expect(query).toContain('rv:externalNamespace "person" ; rv:externalKey "same-key"');
  expect(query).toContain('?subjectParticipation rv:participant ?externalSubject');
  expect(query).toContain('?externalSubject a rv:ExternalReference ; rv:externalProvider "native"');
});

test('native multi-subject occurrences keep sibling participation traits outside the selected witness', async () => {
  const f = await publishedFixture(true, false, true);
  const inverse = selectAssociations({ ...selection, parameters: { ...selection.parameters,
    direction: 'subject-to-work', roots: [{ kind: 'resource', ref: id(11) }] } });
  const page = await readNativeAssociationPage(f.session, inverse, 'query');
  expect(page.complete).toBe(true);
  expect(page.items[0]).toMatchObject({ subject: { kind: 'resource', ref: id(11) },
    participations: [{ id: f.state.workParticipation }, { id: f.state.subjectParticipation }, { id: id(185) }],
    statements: [{ id: id(102) }, { id: id(104) }] });
  expect(f.live.queries.find(query => query.includes('SELECT DISTINCT ?statement ?revision')
    && query.includes('rv:ParticipationCoverage'))).toContain(`rv:coveredParticipation <${f.state.subjectParticipation}>`);
});

test('visitor native identity and adoption remain readable when optional Source annotation owner is unavailable', async () => {
  for (const relation of [false, true]) {
    const f = await publishedFixture(relation, true);
    expect(f.session.principal).toBeNull();
    const page = await readNativeAssociationPage(f.session, selection, 'query');
    expect(page.complete).toBe(true);
    expect(page.items[0]).toMatchObject({ occurrence: f.state.credit, subjectParticipation: f.state.subjectParticipation,
      subject: { kind: 'resource', ref: id(11) }, statements: [{ id: id(102) }, { id: id(104) }] });
    const subject = (page.items[0] as { participations: { creditedName?: unknown; sourceIdentity?: unknown }[] }).participations[1]!;
    expect(subject.creditedName).toBeUndefined();
    expect(subject.sourceIdentity).toBeUndefined();
    await f.session.fenceDependencies();
  }
});

test('native credit optional attribution uses the actual current owner and preserves withdrawal and name policy', async () => {
  const f = await publishedFixture(false, true), ownerState = { withdrawn: false, malformed: false, name: true };
  f.session.principal = { issuer: 'https://account.example', subject: 'reader' };
  f.session.options.actingSubject = id(10);
  f.session.deps.personPreferences = { visibleNameOwners: async () => new Set(ownerState.name ? [id(11)] : []) } as unknown as MainWorkDependencies['personPreferences'];
  f.session.deps.relationAttribution = { async verify({ requests, participations }) { return {
    guard: 'actual-attribution-owner-current-guard', proofs: requests.map(({ participation, support }) => ({
      basis: support.basis, participant: participation.participant, receipt: `urn:rezics:receipt:${hash('actual-citation-command')}`,
      revision: id(182), validationToken: hash('actual-support-head'), evidence: support.evidence,
      state: ownerState.withdrawn ? 'withdrawn' as const : 'current' as const,
      fields: ownerState.malformed ? {} : { creditedName: participation.creditedName,
        ...participations.find(part => part.role === participation.role)?.sourceIdentity },
    })),
  }; } };
  const page = await readNativeAssociationPage(f.session, selection, 'query');
  expect(page.items[0]).toMatchObject({ participations: [{ id: f.state.workParticipation },
    { id: f.state.subjectParticipation, creditedName: f.state.participations[1]!.creditedName,
      sourceIdentity: f.state.participations[1]!.sourceIdentity }] });
  const native = (await readNativeCreditAssociation(f.session, f.state.credit))!;
  ownerState.withdrawn = true;
  await expect(f.session.fenceDependencies()).rejects.toThrow(WorkReadMoved);
  const next = f.session;
  // A new reader observes withdrawal; the identity/tuple itself stays native.
  const withdrawnSession = new WorkReadSession(next.deps, next.request, { actingSubject: id(10) }, next.position);
  withdrawnSession.principal = next.principal;
  const withdrawn = await readNativeAssociationPage(withdrawnSession, selection, 'query');
  const shown = (withdrawn.items[0] as { participations: { creditedName?: unknown; sourceIdentity?: unknown }[] }).participations[1]!;
  expect(shown.creditedName).toBeUndefined();
  expect(shown.sourceIdentity).toBeUndefined();
  ownerState.malformed = true;
  await expect(readNativeCreditAttribution(withdrawnSession, native)).rejects.toThrow('exact supported field');
  delete withdrawnSession.deps.relationAttribution;
  await expect(readNativeCreditAttribution(withdrawnSession, native)).rejects.toThrow('attribution owner');
});

async function nativeAnnotationFixture() {
  const f = await publishedFixture(false, true, false, true);
  const subject = f.state.participations[1]!;
  const owner = { state: 'current' as 'current' | 'withdrawn' | 'withheld', calls: 0,
    corrupt: undefined as ((proof: RelationAttributionProof) => void) | undefined, error: null as Error | null };
  f.session.deps.nativeCreditAnnotationProof = async (participation, support) => {
    owner.calls++;
    expect(participation).toMatchObject({ role: f.state.role, participant: subject.participant, position: 3 });
    if (owner.error) throw owner.error;
    if (owner.state === 'withheld') return null;
    const proof: RelationAttributionProof = { basis: support.basis, participant: participation.participant,
      receipt: `urn:rezics:receipt:${hash('independent-native-source-annotation')}`,
      revision: f.state.creditRevision, validationToken: hash(owner.state), state: owner.state,
      fields: { creditedName: subject.creditedName, ...subject.sourceIdentity }, evidence: [...support.evidence] };
    owner.corrupt?.(proof);
    return proof;
  };
  return { ...f, owner, subject };
}

test('anonymous native credit reads independently public Source fields through their exact read-proof owner', async () => {
  const f = await nativeAnnotationFixture();
  expect(f.session.principal).toBeNull();
  expect(f.session.options.actingSubject).toBeUndefined();
  expect(f.session.deps.relationAttribution).toBeUndefined();
  const page = await readNativeAssociationPage(f.session, selection, 'query');
  expect(page.complete).toBe(true);
  expect(page.items[0]).toMatchObject({ occurrence: f.state.credit, subject: f.subject.participant,
    participations: [{ id: f.state.workParticipation }, { id: f.subject.id,
      creditedName: f.subject.creditedName, sourceIdentity: f.subject.sourceIdentity }],
    statements: [{ id: id(102) }, { id: id(104) }] });
  expect(f.owner.calls).toBeGreaterThan(0);
  await f.session.fenceDependencies();
});

test('missing or private native Source proof withholds optional fields while preserving the native tuple and adoption', async () => {
  for (const missing of [true, false]) {
    const f = await nativeAnnotationFixture();
    if (missing) delete f.session.deps.nativeCreditAnnotationProof;
    else f.owner.state = 'withheld';
    const native = (await readNativeCreditAssociation(f.session, f.state.credit))!;
    expect(await readNativeCreditAttribution(f.session, native)).toEqual(f.state.participations.map(part => ({
      participation: part.id, currentFields: [] })));
    const page = await readNativeAssociationPage(f.session, selection, 'query');
    expect(page.items[0]).toMatchObject({ occurrence: f.state.credit, subject: f.subject.participant,
      statements: [{ id: id(102) }, { id: id(104) }] });
    const shown = (page.items[0] as { participations: { creditedName?: unknown; sourceIdentity?: unknown }[] }).participations[1]!;
    expect(shown.creditedName).toBeUndefined();
    expect(shown.sourceIdentity).toBeUndefined();
    await f.session.fenceDependencies();
  }
});

test('actual native Source withdrawal changes the read fence and removes only the optional fields for a new reader', async () => {
  const f = await nativeAnnotationFixture();
  await readNativeAssociationPage(f.session, selection, 'query');
  f.owner.state = 'withdrawn';
  await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const next = new WorkReadSession(f.session.deps, f.session.request, {}, f.session.position);
  const native = (await readNativeCreditAssociation(next, f.state.credit))!;
  expect(await readNativeCreditAttribution(next, native)).toEqual(f.state.participations.map(part => ({
    participation: part.id, currentFields: [] })));
  const page = await readNativeAssociationPage(next, selection, 'query');
  expect(page.items[0]).toMatchObject({ occurrence: f.state.credit, subject: f.subject.participant,
    statements: [{ id: id(102) }, { id: id(104) }] });
  const shown = (page.items[0] as { participations: { creditedName?: unknown; sourceIdentity?: unknown }[] }).participations[1]!;
  expect(shown.creditedName).toBeUndefined();
  expect(shown.sourceIdentity).toBeUndefined();
  await next.fenceDependencies();
});

test('native Source read proof refuses wrong exact identities and fields and preserves unexpected transport failure', async () => {
  const corruptions: Array<(proof: RelationAttributionProof) => void> = [
    proof => { proof.basis = { kind: 'native-credit', credit: id(901), revision: id(902) }; },
    proof => { proof.participant = { kind: 'external', provider: 'native', namespace: 'other', key: 'same-key' }; },
    proof => { proof.evidence = [id(903)]; },
    proof => { proof.receipt = 'invalid-receipt'; },
    proof => { proof.receipt = workEditReceiptIri(id(12).slice(-36)); },
    proof => { proof.revision = 'invalid-revision'; },
    proof => { proof.revision = id(904); },
    proof => { proof.validationToken = 'invalid-token'; },
    proof => { proof.fields.alias = 'Wrong alias'; },
    proof => { delete proof.fields.note; },
  ];
  for (const corrupt of corruptions) {
    const f = await nativeAnnotationFixture();
    f.owner.corrupt = corrupt;
    const native = (await readNativeCreditAssociation(f.session, f.state.credit))!;
    await expect(readNativeCreditAttribution(f.session, native)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  const f = await nativeAnnotationFixture(), error = new Error('Source transport unavailable');
  f.owner.error = error;
  await expect(readNativeAssociationPage(f.session, selection, 'query')).rejects.toBe(error);
});
