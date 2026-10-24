import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DataFactory, Parser, Store, type Term } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { ACTIVE_GENERATION, familyReceiptIri, sealComponentState, StaleSemanticHead,
  type SemanticAdmission } from '../src/modules/semantic/command.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { MODEL_COMPONENT, PROFILES } from '../src/modules/semantic/schema.ts';
import { canonicalRelation, changeRelationOccurrence, readCurrentOccurrence, RELATION_CHANGE_FAMILY,
  relationChangeDigest, roleIri, type ExactDefinition, type RelationInput } from '../src/modules/relation/change.ts';
import { relationAttributionVerifier, type RelationAttributionOwner, type RelationAttributionProof } from '../src/modules/relation/attribution.ts';
import { readAttributedOccurrence, validateAttributedOccurrence } from '../src/modules/relation/v2-read.ts';
import { canonicalAttribution, checkedAttributionSupports, checkedParticipationsV2, checkedSourceIdentity,
  RELATION_V2_PROFILE, type AttributedParticipation } from '../src/modules/relation/v2-schema.ts';
import type { CreditAttributionSupport } from '../src/modules/work/credit-association-state.ts';
import { DATASET, GRAPHS, hash, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => 'https://rezics.com/id/00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const resource = (n: number) => ({ kind: 'resource' as const, ref: id(n) });
const definition: ExactDefinition = { definition: id(1), revision: id(2), lifecycle: 'active',
  modelRevision: PROFILES.definitionV2, workSubjectRole: 'work',
  association: { kind: 'appearance', workRole: 'work', subjectRoles: ['subject'] },
  roles: [{ role: roleIri(id(1), 'work'), minParticipants: 1, maxParticipants: 1, ordered: false },
    { role: roleIri(id(1), 'subject'), minParticipants: 1, maxParticipants: 64, ordered: true }],
  roleKeys: { [roleIri(id(1), 'work')]: 'work', [roleIri(id(1), 'subject')]: 'subject' } };
const sourceIdentity = { provider: 'vndb', namespace: 'character', key: 'c41', alias: '別名', eid: null, note: null };
const support: CreditAttributionSupport = { basis: { kind: 'source-binding', binding: id(10) },
  fields: ['provider', 'namespace', 'key', 'alias'], evidence: [id(11)] };
const input = (): RelationInput => ({ profile: 'relation-change-v2', definition: definition.revision,
  participations: [{ role: 'work', participant: resource(3) }, { role: 'subject', position: 0,
    participant: { kind: 'external', provider: 'vndb', namespace: 'character', key: 'c41' } }] });
const attributed = () => checkedParticipationsV2(definition.roles, [{ role: definition.roles[0]!.role, participant: resource(3) },
  { role: definition.roles[1]!.role, position: 0, participant: resource(4), sourceIdentity,
    attributionSupports: [support] }]);
const principal = { issuer: 'https://account.test', subject: 'verified-account' } as VerifiedPrincipal;
function attributionOwner(change: (proof: RelationAttributionProof) => void = () => {}): RelationAttributionOwner {
  return { verify: async ({ requests }) => ({ guard: 'FILTER(true)', proofs: requests.map(({ participation, support }) => {
    const proof: RelationAttributionProof = { basis: support.basis, receipt: 'urn:rezics:receipt:' + hash('source-command'),
      revision: id(12), validationToken: hash('current-support'), state: 'current', evidence: support.evidence,
      participant: participation.participant, fields: Object.fromEntries(support.fields.map(field =>
        [field, field === 'creditedName' ? participation.creditedName : (participation as AttributedParticipation).sourceIdentity?.[field]])) };
    change(proof); return proof;
  }) }) };
}

test('V2 attribution preserves exact source absence, role and native correspondence without inferring identity or sex', () => {
  const parts = attributed();
  expect(parts[1]).toMatchObject({ participant: resource(4), sourceIdentity, attributionSupports: [{
    ...support, fields: [...support.fields].sort(),
  }] });
  expect(parts[0]!.attributionSupports).toEqual([]);
  expect(parts[0]!.sourceIdentity).toBeUndefined();
  expect(parts[1]!.sourceIdentity!.eid).toBeNull();
  expect(JSON.stringify(parts)).not.toContain('male');
  expect(() => checkedParticipationsV2(definition.roles, [{ ...parts[0] }, {
    ...parts[1], attributionSupports: [{ ...support, fields: ['key'] }],
  }])).toThrow('every asserted source identity field');
  expect(() => checkedParticipationsV2(definition.roles, [{ ...parts[0] }, {
    ...parts[1], attributionSupports: [{ ...support, fields: [...support.fields, 'eid'] }],
  }])).toThrow('absent field');
});

test('source identities and citations are closed, qualified and bounded; omitted is different from null or empty', () => {
  for (const bad of [null, { ...sourceIdentity, alias: '' }, { ...sourceIdentity, note: 'x'.repeat(2001) },
    { ...sourceIdentity, provider: 'VN DB' }, { ...sourceIdentity, eid: '\n' }, { ...sourceIdentity, extra: 'x' },
    { provider: 'vndb', namespace: 'character', key: 'c41' }]) expect(() => checkedSourceIdentity(bad)).toThrow();
  for (const bad of [{ ...support, evidence: [] }, { ...support, evidence: [id(11), id(11)] },
    { ...support, evidence: ['https://example.test/\n'] }, { ...support, fields: ['alias', 'alias'] },
    { ...support, basis: { ...support.basis, receipt: id(1) } }, { ...support, fields: ['invented'] }]) {
    expect(() => checkedAttributionSupports([bad])).toThrow();
  }
  expect(() => checkedAttributionSupports(Array.from({ length: 17 }, (_, n) => ({
    ...support, basis: { kind: 'source-binding', binding: id(100 + n) },
  })))).toThrow('count');
  const rows = (count: number, distinctBases: boolean) => [{ role: definition.roles[0]!.role, participant: resource(3) },
    ...Array.from({ length: count }, (_, n) => ({ role: definition.roles[1]!.role, participant: resource(20 + n), position: n,
      creditedName: { lexical: 'Exact occurrence name', language: 'en' }, attributionSupports: Array.from({ length: 16 }, (_, i) => ({
        basis: { kind: 'source-binding', binding: id(distinctBases ? 200 + n * 16 + i : 200) },
        fields: ['creditedName'], evidence: [id(300 + n * 16 + i)],
      })) }))];
  expect(() => checkedParticipationsV2(definition.roles, rows(3, true))).toThrow('distinct basis or evidence budget');
  expect(checkedParticipationsV2(definition.roles, rows(4, false))).toHaveLength(5);
  expect(() => checkedParticipationsV2(definition.roles, rows(5, false))).toThrow('distinct basis or evidence budget');
});

test('the V1 digest stays byte compatible; authored metadata and source evidence are part of the V2 intent', () => {
  const legacyDefinition = { ...definition, association: undefined };
  const { profile: _, ...legacyInput } = input();
  const legacy = canonicalRelation(legacyDefinition, legacyInput);
  expect(relationChangeDigest(undefined, null, legacy)).toBe(hash(JSON.stringify({
    family: 'relation-change-v1', occurrence: null, expectedHead: null, definition: definition.revision,
    lifecycle: 'active', applicability: [], participations: legacy.participations.map(({ role, participant, position }) =>
      ({ role, participant, ...(position === undefined ? {} : { position }) })),
  })));
  expect(() => canonicalRelation(definition, legacyInput)).toThrow('Select relation-change-v2');
  const command = { ...input(), participations: input().participations.map(part => part.role === 'subject'
    ? { ...part, sourceIdentity, attributionSupports: [support] } : part) };
  const state = canonicalRelation(definition, command);
  expect(relationChangeDigest(undefined, null, state)).not.toBe(relationChangeDigest(undefined, null, legacy));
  const changed = canonicalRelation(definition, { ...command, participations: command.participations.map(part =>
    part.role === 'subject' ? { ...part, attributionSupports: [{ ...support, evidence: [id(13)] }] } : part) });
  expect(relationChangeDigest(undefined, null, changed)).not.toBe(relationChangeDigest(undefined, null, state));
});

test('one attribution owner batch verifies exact fields and citations and cannot disclose its unrequested fields', async () => {
  let batches = 0;
  const livePrincipal: VerifiedPrincipal = { ...principal, currentAssertion: async () => principal };
  const base = attributionOwner(proof => { proof.fields.note = 'not requested and not disclosed'; });
  const verifier = relationAttributionVerifier({ verify: async value => {
    expect(value.principal).toBe(livePrincipal); batches++; return base.verify(value);
  } }, livePrincipal, id(5));
  const result = await verifier(definition, attributed());
  expect(batches).toBe(1);
  expect(result.proofs[0]!.fields).toEqual({ alias: '別名', key: 'c41', namespace: 'character', provider: 'vndb' });
  expect(result.proofs[0]!.participant).toEqual(resource(4));
  expect(result.proofs[0]!.fields.note).toBeUndefined();
  expect(await relationAttributionVerifier(undefined, principal, id(5))(definition, [])).toEqual({ proofs: [], guard: '' });
  await expect(relationAttributionVerifier(undefined, principal, id(5))(definition, attributed())).rejects.toThrow('owner is unavailable');
  await expect(relationAttributionVerifier({ verify: async () => null }, principal, id(5))(definition, attributed()))
    .rejects.toMatchObject({ code: 'unavailable-reference' });
});

test('withdrawn support, a matched key without native correspondence, wrong fields, citations or receipt cannot certify attribution', async () => {
  const refusals: ((proof: RelationAttributionProof) => void)[] = [
    proof => { proof.state = 'withdrawn'; }, proof => { proof.participant = resource(99); },
    proof => { proof.fields.alias = 'another alias'; }, proof => { proof.evidence = [id(90)]; },
    proof => { proof.receipt = id(12); }, proof => { proof.revision = 'https://rezics.com/id/' + '-'.repeat(36); },
    proof => { proof.basis = { kind: 'source-binding', binding: id(99) }; },
  ];
  for (const change of refusals) await expect(relationAttributionVerifier(attributionOwner(change), principal, id(5))
    (definition, attributed())).rejects.toBeInstanceOf(Error);
});

const directories: string[] = [];
afterAll(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const { namedNode, literal, quad } = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const binding = (term: Term) => term.termType === 'NamedNode' ? { type: 'uri', value: term.value } : {
  type: 'literal', value: term.value, ...(term.termType === 'Literal' ? { datatype: term.datatype.value,
    ...(term.language ? { 'xml:lang': term.language } : {}) } : {}),
};
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const result = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
// These owner tests execute the real codec, immutable objects, command construction
// and receipt recovery against retained RDF. They do not execute Fuseki/SHACL or prove an API adoption.
function block(text: string, label: string) {
  const start = text.indexOf('{', text.indexOf(label));
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: text.slice(start + 1, i), start, end: i + 1 };
  }
  throw new Error('unclosed command graph block');
}
const rdf = (body: string) => new Parser({ format: 'TriG' }).parse('@prefix rv: <' + RV + '> .\n' + body);
function exactChildren(store: Store, query: string) {
  const closed = [...query.matchAll(/FILTER NOT EXISTS \{ <([^>]+)> \?(?:p|externalP) \?/g)].map(match => match[1]!);
  let body = block(query, 'ASK').body;
  while (body.includes('FILTER NOT EXISTS')) {
    const at = body.indexOf('FILTER NOT EXISTS'), removed = block(body.slice(at), 'FILTER NOT EXISTS');
    body = body.slice(0, at) + body.slice(at + removed.end);
  }
  const expected = new Store(rdf(body));
  if (expected.getQuads(null, null, null, null).some(value => !store.has(value))) return false;
  return closed.every(subject => {
    const graph = namedNode(GRAPHS.revisions), ref = namedNode(subject);
    const actual = store.getQuads(ref, null, null, graph), exact = expected.getQuads(ref, null, null, graph);
    return actual.length === exact.length && actual.every(value => expected.has(value));
  });
}
async function fixture() {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join('.temp', 'relation-attribution-')); directories.push(directory);
  const store = new Store(), queries: string[] = [], commands: CommandEnvelope[] = [];
  const get = (subject: string, predicate: string, graph: string) => store.getObjects(namedNode(subject), namedNode(predicate), namedNode(graph))[0];
  const add = (subject: string, predicate: string, object: ReturnType<typeof namedNode> | ReturnType<typeof literal>, graph: string) =>
    store.addQuad(quad(namedNode(subject), namedNode(predicate), object, namedNode(graph)));
  const receiptRef = (query: string) => query.match(/<urn:rezics:receipt:[0-9a-f]{64}>/)?.[0].slice(1, -1);
  const nativeRef = (query: string) => query.match(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/)![0].slice(1, -1);
  let lostReply = false;
  const fuseki = {
    commandHealth: async () => ({ moduleVersion: COMMAND_MODULE_VERSION,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) }),
    commandWithReceipt: async (command: CommandEnvelope) => {
      commands.push(command);
      if (get(command.receipt, RV + 'outcome', GRAPHS.receipts)) return { status: 'committed' };
      const next = Number(get(DATASET, RV + 'sequence', GRAPHS.control)!.value) + 1;
      const parse = (label: string) => rdf(block(command.update, label).body.replaceAll('?next', String(next)).replaceAll('?n', String(next - 1)));
      const inserts = parse('INSERT');
      const expected = inserts.find(value => value.subject.value === command.receipt && value.predicate.value === RV + 'expectedHead');
      const component = inserts.find(value => value.subject.value === command.receipt && value.predicate.value === RV + 'component');
      if (expected && get(component!.object.value, RV + 'occurrenceHead', GRAPHS.current)?.value !== expected.object.value) return { status: 'committed' };
      store.removeQuads(parse('DELETE')); store.addQuads(inserts);
      if (lostReply) { lostReply = false; throw new Error('committed reply lost'); }
      return { status: 'committed' };
    },
    query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      if (query.includes('rv:rejectionKind rv:InvalidProfile')) return { boolean: false };
      if (query.includes('ASK') && query.includes('VALUES (?expectedP ?expectedO)')) return { boolean: exactChildren(store, query) };
      if (query.includes('ASK') && query.includes('rv:ModelGeneration')) return { boolean:
        !!get(ACTIVE_GENERATION, RDF_TYPE, GRAPHS.revisions) && get(MODEL_COMPONENT, RV + 'generationHead', GRAPHS.current)?.value === ACTIVE_GENERATION };
      if (query.includes('SELECT ?subject ?frame') || query.includes('SELECT ?participant WHERE')) return result([]);
      if (query.includes('SELECT ?definition ?manifest ?kind ?model')) {
        const ref = nativeRef(query);
        return result([{ definition: binding(get(ref, RV + 'component', GRAPHS.revisions)!),
          manifest: binding(get(ref, RV + 'manifest', GRAPHS.revisions)!), kind: binding(namedNode(RV + 'RelationDefinition')),
          model: binding(namedNode(PROFILES.definitionV2)) }]);
      }
      if (query.includes('SELECT ?head ?manifest ?model')) {
        const head = get(nativeRef(query), RV + 'occurrenceHead', GRAPHS.current);
        return result(head ? [{ head: binding(head), manifest: binding(get(head.value, RV + 'manifest', GRAPHS.revisions)!),
          model: binding(get(head.value, RV + 'modelRevision', GRAPHS.revisions)!) }] : []);
      }
      if (query.includes('SELECT ?p ?o')) return result(store.getQuads(namedNode(nativeRef(query)), null, null, namedNode(GRAPHS.current))
        .map(value => ({ p: binding(value.predicate), o: binding(value.object) })));
      if (query.includes('SELECT ?manifest ?predecessor')) {
        const ref = nativeRef(query), props = { manifest: 'manifest', predecessor: 'predecessor', epoch: 'dataEpoch',
          sequence: 'sequence', model: 'modelRevision', generation: 'modelGeneration', operation: 'operation' };
        return result([Object.fromEntries(Object.entries(props).flatMap(([key, property]) => {
          const value = get(ref, RV + property, GRAPHS.revisions); return value ? [[key, binding(value)]] : [];
        }))]);
      }
      if (query.includes('SELECT ?receipt ?admission')) {
        const occurrence = query.match(/rv:component <([^>]+)>/)![1], revision = query.match(/rv:revision <([^>]+)>/)![1];
        const operation = query.match(/rv:operation <([^>]+)>/)![1], type = query.match(/\?receipt a rv:(\w+)/)![1];
        return result(store.getSubjects(namedNode(RDF_TYPE), namedNode(RV + type), namedNode(GRAPHS.receipts))
          .filter(ref => get(ref.value, RV + 'component', GRAPHS.receipts)?.value === occurrence
            && get(ref.value, RV + 'revision', GRAPHS.receipts)?.value === revision
            && get(ref.value, RV + 'operation', GRAPHS.receipts)?.value === operation)
          .map(ref => ({ receipt: binding(ref), admission: binding(get(ref.value, RV + 'admissionId', GRAPHS.receipts)!) })));
      }
      if (query.includes('SELECT ?outcome ?reason ?kind ?digest')) {
        const ref = receiptRef(query)!;
        if (!get(ref, RV + 'outcome', GRAPHS.receipts)) return result([]);
        const props = { outcome: 'outcome', reason: 'reason', kind: 'rejectionKind', digest: 'requestDigest',
          admissionId: 'admissionId', authorityEpoch: 'authorityEpoch', scope: 'admittedScope', epoch: 'dataEpoch',
          sequence: 'sequence', component: 'component', revision: 'revision', expected: 'expectedHead', currentHead: 'currentHead' };
        return result([Object.fromEntries(Object.entries(props).flatMap(([key, property]) => {
          const value = get(ref, RV + property, GRAPHS.receipts); return value ? [[key, binding(value)]] : [];
        }))]);
      }
      throw new Error('Unexpected relation owner query: ' + query.slice(0, 150));
    },
  };
  const env = { fuseki, objectDirectory: directory, lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' } } as unknown as WorkActivationEnvironment;
  const manifest = await sealComponentState(env, definition.definition, PROFILES.definitionV2, checkedComponentState({
    component: 'definition', kind: 'relation', roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'subject', minParticipants: 1, maxParticipants: 64, ordered: true }], workSubjectRole: 'work', association: definition.association,
  }, 'semantic-change-v2'));
  add(definition.revision, RV + 'component', namedNode(definition.definition), GRAPHS.revisions);
  add(definition.revision, RV + 'manifest', namedNode(manifest), GRAPHS.revisions);
  add(definition.definition, RV + 'definitionHead', namedNode(definition.revision), GRAPHS.current);
  add(ACTIVE_GENERATION, RDF_TYPE, namedNode(RV + 'ModelGeneration'), GRAPHS.revisions);
  add(MODEL_COMPONENT, RV + 'generationHead', namedNode(ACTIVE_GENERATION), GRAPHS.current);
  add(DATASET, RV + 'sequence', literal('1', namedNode('http://www.w3.org/2001/XMLSchema#integer')), GRAPHS.control);
  const admission = (command: RelationInput, occurrence?: string, expectedHead: string | null = null): SemanticAdmission => ({
    id: Bun.randomUUIDv7(), scope: 'work:edit:' + id(3), action: 'relation.change', authorityEpoch: '1',
    expiresAt: '2030-01-01T00:00:00Z', requestDigest: relationChangeDigest(occurrence, expectedHead, canonicalRelation(definition, command)),
  });
  return { env, store, get, add, queries, commands, admission, loseReply: () => { lostReply = true; } };
}

test('a real V2 command seals exact allocations and its actual receipt; lost-reply replay never allocates again', async () => {
  const f = await fixture(), command = input(), admission = f.admission(command);
  f.loseReply();
  const created = await changeRelationOccurrence(f.env, { input: command, expectedHead: null, admission });
  const read = await readAttributedOccurrence(f.env, created.occurrence, created.revision);
  expect(read.receipt).toBe(familyReceiptIri(admission.id, RELATION_CHANGE_FAMILY));
  expect(read.receipt).not.toBe(created.occurrence);
  expect(read.state.participations).toHaveLength(2);
  expect(new Set(read.state.participations.map(part => part.iri)).size).toBe(2);
  expect(read.modelGeneration).toBe(ACTIVE_GENERATION);
  expect(read.modelRevision).toBe(RELATION_V2_PROFILE);
  expect(read.state.profile).toBe('relation-change-v2');
  expect(read.state.participations.find(part => part.role.endsWith('/subject'))!.participant).toEqual({
    kind: 'external', provider: 'vndb', namespace: 'character', key: 'c41',
  });
  const commands = f.commands.length;
  const replay = await changeRelationOccurrence(f.env, { input: command, expectedHead: null, admission });
  expect(replay).toEqual({ ...created, replayed: true });
  expect((await readAttributedOccurrence(f.env, replay.occurrence, replay.revision)).state).toEqual(read.state);
  expect(f.commands).toHaveLength(commands);
  expect(f.commands[0]!.validations.map(value => value.profile)).toEqual([
    'relation-occurrence-v2', 'relation-occurrence-v2', 'relation-occurrence-v2', 'value-exact-v1',
  ]);
});

test('new revision allocates new exact participations; a never-committed stale request is refused without child creation', async () => {
  const f = await fixture(), command = input();
  const created = await changeRelationOccurrence(f.env, { input: command, expectedHead: null, admission: f.admission(command) });
  const original = await readAttributedOccurrence(f.env, created.occurrence, created.revision);
  const edit = { ...command, participations: command.participations.map(part => part.role === 'subject'
    ? { ...part, creditedName: { lexical: '別表記', language: 'ja' } } : part) };
  const revised = await changeRelationOccurrence(f.env, { input: edit, occurrence: created.occurrence, expectedHead: created.revision,
    admission: f.admission(edit, created.occurrence, created.revision) });
  const next = await readAttributedOccurrence(f.env, revised.occurrence, revised.revision);
  expect(next.predecessor).toBe(created.revision);
  expect(next.state.participations.every(part => original.state.participations.every(prior => prior.iri !== part.iri))).toBe(true);
  const children = f.store.getSubjects(namedNode(RDF_TYPE), namedNode(RV + 'RelationParticipation'), namedNode(GRAPHS.revisions));
  const stale = f.admission(command, created.occurrence, created.revision);
  await expect(changeRelationOccurrence(f.env, { input: command, occurrence: created.occurrence, expectedHead: created.revision,
    admission: stale })).rejects.toBeInstanceOf(StaleSemanticHead);
  expect(f.store.getSubjects(namedNode(RDF_TYPE), namedNode(RV + 'RelationParticipation'), namedNode(GRAPHS.revisions))).toEqual(children);
  expect(f.get(familyReceiptIri(stale.id, RELATION_CHANGE_FAMILY), RV + 'reason', GRAPHS.receipts)?.value).toBe(RV + 'StaleHead');
  expect((await readCurrentOccurrence(f.env, created.occurrence))!.head).toBe(revised.revision);
  expect((await readAttributedOccurrence(f.env, created.occurrence, created.revision)).state).toEqual(original.state);
});

test('exact V2 reads refuse changed native children, extra external identity values and an invented receipt class', async () => {
  const f = await fixture(), command = input();
  const created = await changeRelationOccurrence(f.env, { input: command, expectedHead: null, admission: f.admission(command) });
  const read = await readAttributedOccurrence(f.env, created.occurrence, created.revision);
  const external = read.state.participations.find(part => part.node)!;
  const extra = quad(namedNode(external.node!), namedNode(RV + 'externalKey'), literal('another-key'), namedNode(GRAPHS.revisions));
  f.store.addQuad(extra);
  await expect(readAttributedOccurrence(f.env, created.occurrence, created.revision)).rejects.toThrow('children differ');
  f.store.removeQuad(extra);
  const child = quad(namedNode(external.iri), namedNode(RV + 'role'), namedNode(external.role), namedNode(GRAPHS.revisions));
  f.store.removeQuad(child);
  await expect(readAttributedOccurrence(f.env, created.occurrence, created.revision)).rejects.toThrow('children differ');
  f.store.addQuad(child);
  const receiptType = quad(namedNode(read.receipt), namedNode(RDF_TYPE), namedNode(RV + 'OperationReceipt'), namedNode(GRAPHS.receipts));
  f.store.removeQuad(receiptType);
  await expect(readAttributedOccurrence(f.env, created.occurrence, created.revision)).rejects.toThrow('command receipt is unavailable');
});

test('sealed support history never certifies a currently withdrawn field or a different native command revision', async () => {
  const f = await fixture(), command = { ...input(), participations: input().participations.map(part =>
    part.role === 'subject' ? { ...part, sourceIdentity, attributionSupports: [support] } : part) };
  let withdrawn = false, changed = false;
  const verifier = relationAttributionVerifier(attributionOwner(proof => {
    if (withdrawn) proof.state = 'withdrawn';
    if (changed) proof.revision = id(99);
  }), principal, id(5));
  const created = await changeRelationOccurrence(f.env, { input: command, expectedHead: null, admission: f.admission(command), attribution: verifier });
  const read = await readAttributedOccurrence(f.env, created.occurrence, created.revision);
  expect((await validateAttributedOccurrence(f.env, read, definition, verifier)).proofs).toHaveLength(1);
  const history = canonicalAttribution(read.state.attributionProofs);
  withdrawn = true;
  await expect(validateAttributedOccurrence(f.env, read, definition, verifier)).rejects.toMatchObject({ code: 'unavailable-reference' });
  withdrawn = false; changed = true;
  await expect(validateAttributedOccurrence(f.env, read, definition, verifier)).rejects.toThrow('sealed source revision');
  expect(canonicalAttribution((await readAttributedOccurrence(f.env, created.occurrence, created.revision)).state.attributionProofs)).toBe(history);
});
