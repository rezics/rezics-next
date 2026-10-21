import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { RetainedRelationReadDependencies } from '../src/modules/relation/retained-change.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { familyReceiptIri, sealComponentState } from '../src/modules/semantic/command.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { retainedStatementCoverageReader } from '../src/modules/statement/retained-coverage.ts';
import { resolveStatementCoverage } from '../src/modules/statement/v2-coverage.ts';
import { checkedStatementMeaningV2, OCCURRENCE_ASSERTION_NOTATION, type StatementMeaningV2 } from '../src/modules/statement/v2-schema.ts';
import { systemDisclosure } from '../src/modules/target/disclosed-references.ts';
import { hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { retainedCreditAssociationDigest, RETAINED_CREDIT_ASSOCIATIONS, RETAINED_CREDIT_ASSOCIATIONS_PROFILE } from '../src/modules/work/credit-association-state.ts';
import { prepareRetainedCreditBinding } from '../src/modules/work/credit-association-write.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const receipt = (key: string) => `urn:rezics:receipt:${hash(key)}`;
const directory = resolve('.temp', `statement-retained-coverage-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const rows = (...values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key,
    { type: /^(https:|urn:)/.test(text) ? 'uri' : 'literal', value: text }])) ) } });
const principal: VerifiedPrincipal = { issuer: 'https://account.example', subject: 'editor' };

/** Actual immutable seals, receipt/digest checks and retained owner readers;
 * bounded graph/Source/Access transports supply current state. No activation,
 * public adoption or native API proof is asserted by this fixture. */
async function fixture() {
  const credit = id(1), revision = id(2), work = id(3), definition = id(4), definitionRevision = id(5);
  const admission = id(6).slice(-36), commandReceipt = familyReceiptIri(admission, RETAINED_CREDIT_ASSOCIATIONS);
  const generation = `urn:rezics:model-generation:${hash('generation')}`;
  const live = { sequence: '21', head: revision as string | null, support: 'current' as 'current' | 'withdrawn',
    sourceAvailable: true, readable: true, guarded: true, assertionAvailable: true, assertionHead: id(21) };
  let manifest = '', definitionManifest = '', assertionManifest = '';
  const queries: string[] = [];
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' },
    fuseki: { query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      if (query.includes('a rv:RelationOccurrenceRevision')) return rows();
      if (query.includes('SELECT ?head WHERE')) return rows({ head: revision });
      if (query.includes('SELECT ?epoch ?routing ?sequence')) return rows({ epoch: 'epoch-one', routing: '1', sequence: live.sequence });
      if (query.includes('SELECT ?generation WHERE')) return rows({ generation });
      if (query.includes('SELECT ?manifest ?number')) return rows({ manifest: `urn:rezics:sha256:${hash('model')}`, number: '1',
        entailment: RV + 'NoEntailment', digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: hash('generation') })) });
      if (query.includes('SELECT ?manifest ?predecessor ?receipt')) return rows({ manifest, work, creditRevision: id(7),
        receipt: commandReceipt, admission, scope: `work:edit:${work}`, epoch: 'epoch-one', sequence: '12',
        digest: retainedCreditAssociationDigest(state, null), operation: id(8), receiptOperation: id(8), modelGeneration: generation });
      if (query.includes('SELECT ?associationHead WHERE')) return live.head ? rows({ associationHead: live.head }) : rows();
      if (query.includes('SELECT ?definition ?manifest')) {
        if (query.includes(`<${id(21)}>`)) return live.assertionAvailable ? rows({ definition: id(20), manifest: assertionManifest,
          kind: RV + 'PropertyDefinition', model: PROFILES.definitionV2 }) : rows();
        return rows({ definition, manifest: definitionManifest, kind: RV + 'RelationDefinition', model: PROFILES.definitionV2 });
      }
      if (query.includes('SELECT ?definition ?head')) return rows({ definition: id(20), head: live.assertionHead });
      if (query.includes('SELECT ?operation ?generation')) return rows({ operation: id(8), generation });
      if (query.includes('ASK')) return { boolean: live.guarded };
      throw new Error(`Unexpected owner query: ${query.slice(0, 130)}`);
    } } } as unknown as WorkActivationEnvironment;
  const binding = await prepareRetainedCreditBinding(env, { credit, creditRevision: id(7), work, workRevision: id(9),
    retainedProfile: 'source-reported-credit-v1', role: 'author', expectedAssociationHead: null,
    origin: { kind: 'source-binding', binding: id(10), proposal: id(11), conversion: id(12),
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
  assertionManifest = await sealComponentState(env, id(20), PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'property', roles: [], notation: OCCURRENCE_ASSERTION_NOTATION,
  }, 'semantic-change-v2'));
  const deps: RetainedRelationReadDependencies = { environment: env,
    access: { canReadWork: async () => live.readable } as unknown as RetainedRelationReadDependencies['access'],
    retainedCreditRelations: { reads: {
      activation: async () => { throw new Error('Statement coverage cannot require or invent public activation'); },
      coverage: async () => { throw new Error('Writing a Statement cannot require its future adoption'); },
      origin: async () => live.sourceAvailable ? { credit, creditRevision: state.creditRevision, work, workRevision: state.workRevision,
        role: state.role, retainedProfile: state.retainedProfile, origin: structuredClone(state.origin),
        participations: structuredClone(state.participations), receipt: receipt('source-command'),
        validation: [{ basis: { kind: 'source-binding', binding: id(10) }, state: live.support, receipt: receipt('source-command'),
          validationToken: hash(live.support), fields: {}, evidence: [] }] } : null,
    } } };
  const meaning: StatementMeaningV2 = { subject: state.participations[1]!.participant,
    predicate: id(20), relationDefinition: id(21), value: { kind: 'language-string', lexical: 'Editor', language: 'en' },
    applicability: [], interpretationDefinitions: [], coverage: { kind: 'participation', occurrence: credit,
      occurrenceRevision: revision, participation: state.subjectParticipation } };
  const read = retainedStatementCoverageReader(deps, principal, id(22));
  const resolveCoverage = (value = meaning, canRead: (reference: string) => Promise<boolean> = async () => true, disclose = systemDisclosure) =>
    resolveStatementCoverage(env, value, canRead, async () => true, disclose, undefined, undefined, read);
  return { deps, env, live, queries, state, meaning, read, resolveCoverage, commandReceipt, revision };
}

test('retained participation coverage resolves actual seal/receipt and exact allocations before activation', async () => {
  const f = await fixture(), before = structuredClone(f.state);
  const covered = await f.resolveCoverage();
  expect(covered.native?.receipt).toBe(f.commandReceipt);
  expect(covered.references).toContain(f.state.credit);
  expect(covered.references).toContain(f.state.subjectParticipation);
  expect(covered.guard).toContain('rv:associationHead');
  expect(covered.guard).toContain('STR(?retainedCoverageSequence) = "21"');
  expect(covered.guard).not.toContain('rv:RelationOccurrence ;');
  expect(f.state).toEqual(before);
  const owner = await f.read(f.state.credit, f.revision);
  expect(owner?.state.participations.map(part => part.iri)).toEqual(f.state.participations.map(part => part.id));
  expect(owner?.state.participations[1]?.position).toBe(3);
  expect(owner?.state.participations[1]?.participant).toEqual(f.meaning.subject);
  expect(await f.resolveCoverage({ ...f.meaning, subject: { key: 'OL42A', namespace: 'author',
    provider: 'openlibrary', kind: 'external' } })).toEqual(covered);
  expect(f.queries.some(query => query.includes('INSERT') || query.includes('DELETE'))).toBe(false);
});

test('equal names or keys cannot move a retained trait to another subject, role, occurrence or participation', async () => {
  const f = await fixture();
  for (const changed of [
    { ...f.meaning, subject: { kind: 'external' as const, provider: 'openlibrary', namespace: 'work', key: 'OL42A' } },
    { ...f.meaning, coverage: { ...f.meaning.coverage, participation: f.state.workParticipation } },
    { ...f.meaning, coverage: { ...f.meaning.coverage, participation: id(90) } },
  ]) await expect(f.resolveCoverage(changed as StatementMeaningV2)).rejects.toThrow('this exact subject');
  await expect(f.resolveCoverage(f.meaning, async ref => ref !== f.state.work)).rejects.toThrow('co-participant is unavailable');
  await expect(f.resolveCoverage(f.meaning, async () => true, async () => new Set())).rejects.toThrow('covered occurrence is unavailable');
});

test('retained occurrence coverage binds the exact authored assertion property and original credit revision', async () => {
  const f = await fixture();
  const meaning = checkedStatementMeaningV2({ ...f.meaning,
    subject: { kind: 'resource', ref: f.state.credit }, value: { kind: 'resource', ref: f.revision },
    coverage: { kind: 'occurrence', occurrence: f.state.credit, occurrenceRevision: f.revision } });
  const covered = await f.resolveCoverage(meaning);
  expect(covered.native?.receipt).toBe(f.commandReceipt);
  expect(covered.references).toContain(f.state.credit);
  expect(covered.references).toContain(f.revision);
  expect(covered.references).not.toContain(f.state.subjectParticipation);
  expect(covered.guard).toContain(`<${id(20)}> rv:definitionHead <${id(21)}>`);
  f.live.assertionHead = id(92);
  await expect(f.resolveCoverage(meaning)).rejects.toThrow('assertion binding is absent or ambiguous');
  f.live.assertionHead = id(21); f.live.assertionAvailable = false;
  await expect(f.resolveCoverage(meaning)).rejects.toThrow('exact authored occurrence-assertion property');
  expect(() => checkedStatementMeaningV2({ ...meaning, value: { kind: 'resource', ref: id(92) } }))
    .toThrow('that exact occurrence and revision');
});

test('support withdrawal, retirement, replacement and changed commit position refuse exact retained coverage', async () => {
  const f = await fixture(), before = structuredClone(f.state);
  await f.resolveCoverage();
  f.live.support = 'withdrawn';
  await expect(f.resolveCoverage()).rejects.toThrow('support withdrawn');
  f.live.support = 'current'; f.live.sourceAvailable = false;
  await expect(f.resolveCoverage()).rejects.toThrow('original occurrence differs');
  f.live.sourceAvailable = true; f.live.head = null;
  await expect(f.resolveCoverage()).rejects.toThrow('compatibility head unavailable');
  f.live.head = id(91);
  await expect(f.resolveCoverage()).rejects.toThrow('binding changed');
  f.live.head = f.revision; f.live.guarded = false;
  await expect(f.resolveCoverage()).rejects.toThrow('changed or is retired');
  f.live.guarded = true; f.live.sequence = '22';
  expect((await f.resolveCoverage()).guard).toContain('STR(?retainedCoverageSequence) = "22"');
  expect(f.state).toEqual(before);
  expect(f.queries.some(query => query.includes('INSERT') || query.includes('DELETE'))).toBe(false);
});

test('retained coverage refuses missing owners and anonymous authority instead of claiming an empty activation', async () => {
  const f = await fixture();
  await expect(retainedStatementCoverageReader(f.deps, null)(f.state.credit, f.revision)).rejects.toThrow('verified owner reader');
  await expect(retainedStatementCoverageReader({ ...f.deps, retainedCreditRelations: undefined }, principal, id(22))(
    f.state.credit, f.revision)).rejects.toThrow('relation owners unavailable');
  expect(await f.resolveCoverage({ ...f.meaning, coverage: { kind: 'subject-global' } })).toEqual({ guard: '', applicability: [], references: [] });
});
