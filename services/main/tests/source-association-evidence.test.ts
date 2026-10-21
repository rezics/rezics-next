import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, FusekiReadBudgetExceeded, FusekiReadDeadlineExceeded,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { AssociationEvidenceClaim } from '../src/modules/relation/evidence.ts';
import type { AssociationCitation, AssociationEvidenceSelection } from '../src/modules/relation/evidence-contract.ts';
import { associationSourceEvidenceSelection, SourceAssociationEvidenceOwner } from '../src/modules/source/association-evidence.ts';
import type { SourceEvidenceFrontier, SourceEvidenceSelection, SourceEvidenceSupport,
  SourceEvidenceSupportWindow } from '../src/modules/source/field-support-retained.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { WikiEvidenceRow } from '../src/modules/wiki/evidence.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection: AssociationEvidenceSelection = { profile: 'association-evidence-v1', occurrence: id(1), revision: id(2),
  claim: id(1), claimRevision: id(2), context: 'global', position: 'start', frame: [], limit: 1 };

/** Admitted native claim and Source-window owner doubles isolate the production
 * adapter. The real Source store's SQL/native/Rights checks are covered by
 * source-field-evidence-window; these doubles prove no installed admission. */
function fixture(count = 0) {
  let generation = '1', visible = true;
  const native = { statement: id(3), revision: id(4), subject: { kind: 'resource', ref: id(5) }, evidence: [],
    coverage: { kind: 'occurrence', occurrence: id(1), occurrenceRevision: id(2) } };
  const claim = { occurrence: { kind: 'native-relation', state: { evidence: [] } }, assertion: native,
    statement: null } as unknown as AssociationEvidenceClaim;
  const coordinates: SourceEvidenceSelection[] = [];
  const windows: (SourceEvidenceFrontier | undefined)[] = [];
  const supports = (): SourceEvidenceSupport[] => Array.from({ length: count }, (_, index) => ({
    support: id(100 + index), supportIdentity: id(200 + index), record: id(50),
    evidence: !visible || index < 16 ? null : { id: id(50), sourceWork: null, representationSha256: 'a'.repeat(64),
      locator: { pointer: '/authors/3/name' }, attribution: { sourceName: 'Open Library', sourceUrl: null, licence: null },
      rightsBasis: { basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: null, obligations: [],
        useScope: 'quotation', result: 'supported', memberOrdinals: [0] },
      quote: 'The stored field', quoteWithheld: false, language: { state: 'null' } },
  }));
  const store = { async readEvidenceSupportWindow(_session: WorkReadSession, selected: SourceEvidenceSelection,
    after: SourceEvidenceFrontier | undefined, limit: number): Promise<SourceEvidenceSupportWindow> {
    coordinates.push(structuredClone(selected)); windows.push(after);
    const remaining = supports().filter(row => !after || row.support > after.after), items = remaining.slice(0, limit);
    const more = remaining.length > limit;
    return { generation, items, more, next: more ? { generation, after: items.at(-1)!.support } : null };
  } };
  const manual: { claims: readonly string[]; kind: string }[] = [];
  const deps = { environment: {}, access: { assertRecoveryOpen: async () => {} }, wikiEvidence: {
    forClaims: async (claims: readonly string[], kind: string) => { manual.push({ claims, kind }); return []; },
    withheld: async () => new Set<string>(),
  } } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://test/v1/relations/one'), {},
    { dataEpoch: 'epoch', sequence: '1' });
  return { claim, native, deps, store, session, manual, coordinates, windows,
    owner: new SourceAssociationEvidenceOwner(store), generation: () => { generation = String(Number(generation) + 1); },
    visible: (value: boolean) => { visible = value; } };
}

test('native evidence uses the adopted assertion coordinates and refuses unrelated or absent native heads', () => {
  const f = fixture();
  expect(associationSourceEvidenceSelection(selection, f.claim)).toEqual({ target: id(5), slot: 'statement-v1#value',
    occurrence: id(1), context: 'global', component: id(3), revision: id(4) });
  f.native.coverage.occurrenceRevision = id(9);
  expect(() => associationSourceEvidenceSelection(selection, f.claim)).toThrow(WorkReadUnavailable);
  const selectedStatement = { ...selection, claim: id(3), claimRevision: id(4) };
  f.claim.statement = { ...f.native, coverage: { kind: 'subject-global' } } as unknown as AssociationEvidenceClaim['statement'];
  expect(associationSourceEvidenceSelection(selectedStatement, f.claim).occurrence).toBeNull();
  expect(() => associationSourceEvidenceSelection({ ...selectedStatement, claimRevision: id(9) }, f.claim))
    .toThrow(WorkReadUnavailable);
  expect(() => associationSourceEvidenceSelection(selection, { ...f.claim, assertion: null } as unknown as AssociationEvidenceClaim))
    .toThrow(WorkReadUnavailable);
});

test('complete Source inventory exceeds one physical window without coalescing independent supports of one record', async () => {
  const f = fixture(35), session = f.session();
  await f.owner.basis(session, selection, f.claim);
  expect(f.windows).toEqual([undefined, { generation: '1', after: id(115) }, { generation: '1', after: id(131) }]);
  expect(new Set(f.coordinates.map(value => JSON.stringify(value))).size).toBe(1);
  const hidden = await f.owner.window(session, selection, f.claim, null, 16);
  expect(hidden).toEqual({ items: [], after: id(115), complete: false });
  const visible = await f.owner.window(session, selection, f.claim, hidden.after, 16);
  expect(visible.items.map(item => item.id)).toEqual(Array.from({ length: 16 }, (_, index) => id(116 + index)));
  expect(visible.items.map(item => 'kind' in item ? item.supportIdentity : null))
    .toEqual(Array.from({ length: 16 }, (_, index) => id(216 + index)));
  expect(new Set(visible.items.map(item => 'kind' in item ? item.record : null))).toEqual(new Set([id(50)]));
  expect(visible.complete).toBe(false);
  const last = await f.owner.window(session, selection, f.claim, visible.after, 16);
  expect(last.items.map(item => item.id)).toEqual([id(132), id(133), id(134)]);
  expect(last).toMatchObject({ after: null, complete: true });
  await session.fenceDependencies();
});

test('empty Source inventory and independent native/manual claim owners need no conversion', async () => {
  const f = fixture(), session = f.session();
  const basis = await f.owner.basis(session, selection, f.claim);
  expect(basis).toMatch(/^[0-9a-f]{64}$/);
  expect(await f.owner.window(session, selection, f.claim, null, 1)).toEqual({ items: [], after: null, complete: true });
  expect(f.manual).toEqual([{ claims: [id(1)], kind: 'relation' }, { claims: [id(1)], kind: 'relation' },
    { claims: [id(3)], kind: 'statement' }, { claims: [id(3)], kind: 'statement' }]);
  await session.fenceDependencies();
});

test('native annotation citations use their Source owner for authored and retained participations', async () => {
  for (const kind of ['native-relation', 'retained-credit'] as const) {
    const f = fixture(), annotation = id(61), participation = id(62);
    const support = { basis: { kind: 'native-credit', credit: id(1), revision: id(2) },
      fields: ['note'], evidence: [annotation] };
    const part = { id: participation, iri: participation, role: 'authored/role/artist',
      participant: { kind: 'external', provider: 'vndb', namespace: 'staff', key: 's17' },
      attributionSupports: [support, { ...support, fields: ['alias'] }] };
    f.claim.occurrence = { kind, state: { evidence: [], participations: [part] } } as unknown as AssociationEvidenceClaim['occurrence'];
    f.claim.definition = { retainedCredit: { storedRole: 'artist' } } as AssociationEvidenceClaim['definition'];
    let visible = true;
    const citation: AssociationCitation = { kind: 'retained-source-field', id: annotation,
      supportIdentity: annotation, record: id(70), sourceWork: null, representationSha256: 'a'.repeat(64),
      locator: { pointer: '/note' }, attribution: { sourceName: 'vndb', sourceUrl: null, licence: null },
      rightsBasis: { basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: null,
        obligations: [], useScope: 'quotation', result: 'supported', memberOrdinals: [0] },
      quote: null, quoteWithheld: true, language: { state: 'null' } };
    const annotations = { citations: async (selected: unknown, selectedSupport: unknown) => {
      expect(selected).toMatchObject({ role: 'artist', participant: part.participant });
      expect(selectedSupport).toMatchObject({ basis: support.basis, evidence: [annotation] });
      return [{ id: annotation, citation: visible ? citation : null }];
    } } as unknown as NonNullable<ConstructorParameters<typeof SourceAssociationEvidenceOwner>[1]>;
    const owner = new SourceAssociationEvidenceOwner(f.store, annotations), session = f.session();
    await owner.basis(session, selection, f.claim);
    expect((await owner.window(session, selection, f.claim, null, 16)).items).toEqual([citation]);
    expect(f.manual).not.toContainEqual({ claims: [annotation], kind: 'relation' });
    visible = false;
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
    const withheld = f.session();
    await owner.basis(withheld, selection, f.claim);
    expect(await owner.window(withheld, selection, f.claim, null, 16)).toEqual({ items: [], after: null, complete: true });
    await expect(f.owner.basis(f.session(), selection, f.claim)).rejects.toThrow('Native annotation evidence owner is unavailable');
  }
});

test('native manual evidence retains its own citation, disclosure and Rights without a retained conversion', async () => {
  const f = fixture(), graph = new FusekiClient('http://graph.invalid');
  let withheld = false, hidden = false;
  const uri = (value: string) => ({ type: 'uri', value }), literal = (value: string) => ({ type: 'literal', value });
  const values = (query: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'u')
    .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
  const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']): SparqlResult => ({ results: { bindings } });
  graph.query = async query => {
    if (query.includes('SELECT ?resource ?head')) return rows(values(query, 'resource').map(resource => ({
      resource: uri(resource), head: uri(id(80)),
    })));
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return rows(values(query, 'r').map(ref => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(ref), type: literal('work'), work: uri(ref), head: uri(id(80)),
      label: { ...literal('Manual source Work'), 'xml:lang': 'en' }, public: literal('true'), erased: literal('false'),
    })));
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return rows(values(query, 'r').map(ref => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(ref), revision: uri(id(80)),
      type: uri('https://schema.org/CreativeWork'),
    })));
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) return rows(values(query, 'work').map(work => ({
      work: uri(work), head: uri(id(80)), owningWork: uri(work), owningHead: uri(id(80)),
    })));
    if (query.includes('SELECT ?epoch ?sequence')) return rows([{ epoch: literal('epoch'), sequence: literal('1') }]);
    throw new Error(`Unexpected manual citation graph read: ${query}`);
  };
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } } as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(env, target => target.work
    ? { resource: target.work, head: id(80), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(env, fixtureDisclosureReader(async targets => targets.map(target =>
    hidden && target.resource === id(1) ? 'hidden' : 'visible')));
  f.deps.environment = env;
  const row: WikiEvidenceRow = { id: id(60), claim: id(1), claimKind: 'relation', sourceWork: id(70),
    representationSha256: 'b'.repeat(64), locator: { page: 3 }, quote: 'Manual passage', method: { kind: 'manual' },
    modality: 'asserted', submitter: id(90), rightsBasis: id(91) };
  f.claim.occurrence = { kind: 'native-relation', state: { evidence: [row.id] } } as unknown as AssociationEvidenceClaim['occurrence'];
  f.deps.wikiEvidence = { forClaims: async (claims: readonly string[], kind: string) =>
    kind === 'relation' && claims.includes(row.claim!) ? [row] : [],
  withheld: async () => new Set(withheld ? [row.id] : []) } as unknown as MainWorkDependencies['wikiEvidence'];
  const session = f.session();
  await f.owner.basis(session, selection, f.claim);
  expect((await f.owner.window(session, selection, f.claim, null, 1)).items).toEqual([{
    id: row.id, sourceWork: row.sourceWork, representationSha256: row.representationSha256, locator: row.locator,
    quote: row.quote, quoteWithheld: false, method: row.method, modality: row.modality,
    submitter: row.submitter, rightsBasis: row.rightsBasis,
  }]);
  withheld = true;
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const current = f.session();
  await f.owner.basis(current, selection, f.claim);
  expect((await f.owner.window(current, selection, f.claim, null, 1)).items[0])
    .toMatchObject({ id: row.id, quote: null, quoteWithheld: true });
  hidden = true;
  await expect(current.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const privateRead = f.session();
  await f.owner.basis(privateRead, selection, f.claim);
  expect(await f.owner.window(privateRead, selection, f.claim, null, 1)).toEqual({ items: [], after: null, complete: true });
});

test('selected support generation, current rights and native head changes refuse the final read', async () => {
  for (const change of ['generation', 'rights', 'head'] as const) {
    const f = fixture(18), session = f.session();
    await f.owner.basis(session, selection, f.claim);
    if (change === 'generation') f.generation();
    else if (change === 'rights') f.visible(false);
    else f.native.revision = id(8);
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  }
});

test('missing manual owner and unavailable Source reads never fabricate an empty complete inventory', async () => {
  const f = fixture();
  delete f.deps.wikiEvidence;
  await expect(f.owner.basis(f.session(), selection, f.claim)).rejects.toBeInstanceOf(WorkReadUnavailable);
  const g = fixture();
  g.store.readEvidenceSupportWindow = async () => { throw new WorkReadUnavailable('Native Source owner unavailable'); };
  await expect(g.owner.basis(g.session(), selection, g.claim)).rejects.toThrow('Native Source owner unavailable');
});

test('physical Source generation and nonadvancing frontier failures cannot issue completion', async () => {
  const f = fixture(34), original = f.store.readEvidenceSupportWindow;
  f.store.readEvidenceSupportWindow = async (...args) => {
    const result = await original(...args);
    return { ...result, generation: args[2] ? '2' : '1' };
  };
  await expect(f.owner.basis(f.session(), selection, f.claim)).rejects.toBeInstanceOf(WorkReadMoved);
  const g = fixture(34), read = g.store.readEvidenceSupportWindow;
  g.store.readEvidenceSupportWindow = async (...args) => {
    const result = await read(...args);
    return args[2] ? { ...result, next: args[2] } : result;
  };
  await expect(g.owner.basis(g.session(), selection, g.claim)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('complete inventory consumes the existing shared call, byte and deadline allocation', async () => {
  for (const allowance of [{ callsLeft: 5, bytesLeft: 1_000_000 }, { callsLeft: 100, bytesLeft: 1 }]) {
    const f = fixture(35);
    await expect(fusekiReadBudget.run({ ...allowance, signal: new AbortController().signal },
      () => f.owner.basis(f.session(), selection, f.claim))).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
  }
  const f = fixture();
  await expect(fusekiReadBudget.run({ callsLeft: 100, bytesLeft: 1_000_000,
    signal: new AbortController().signal, deadline: performance.now() - 1 },
  () => f.owner.basis(f.session(), selection, f.claim))).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
  expect(f.windows).toEqual([]);
});
