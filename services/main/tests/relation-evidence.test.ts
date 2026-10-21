import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { hash, RV } from '../src/modules/work/activate.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { associationEvidenceQuery, associationEvidenceResult, type AssociationCitation,
  type AssociationEvidenceQuery } from '../src/modules/relation/evidence-contract.ts';
import { AssociationEvidenceChanged, AssociationEvidenceCursorInvalid, assertAssociationEvidenceCursorBinding,
  issueAssociationEvidenceCursor, readAssociationEvidenceCursor, type AssociationEvidenceBasis } from '../src/modules/relation/evidence-cursor.ts';
import { associationEvidenceFailure, readAssociationEvidencePage, selectAssociationEvidence,
  type AssociationEvidenceClaim, type AssociationEvidenceSupportReader } from '../src/modules/relation/evidence.ts';
import { readAdoptedOccurrenceV2 } from '../src/modules/statement/v2-read.ts';
import { StatementNotFound } from '../src/modules/statement/read.ts';
import { relationRoutes } from '../src/routes/relations.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query: AssociationEvidenceQuery = { profile: 'association-evidence-v1', context: 'global', position: 'start',
  claim: id(1), claimRevision: id(2), limit: 4 };
const selection = selectAssociationEvidence(id(1), id(2), query);
const basis: AssociationEvidenceBasis = { sourcePosition: { dataEpoch: 'epoch-one', sequence: '4' },
  modelGeneration: `urn:rezics:model-generation:${hash('model')}`, reader: { issuer: 'account', subject: 'one' },
  dependencies: { support: hash('support'), adoption: id(3), disclosure: 'public' } };
const citation = (n: number): AssociationCitation => ({ id: id(n), sourceWork: id(99), representationSha256: hash('immutable'),
  locator: { page: n }, quote: `source ${n}`, quoteWithheld: false, method: { kind: 'manual' },
  modality: 'quotation', submitter: id(98), rightsBasis: 'quotation' });

function fixture() {
  let support = hash('support'), quoteAllowed = true;
  let generation = basis.modelGeneration;
  const source = Array.from({ length: 11 }, (_, i) => ({ ...citation(i + 10), visible: i >= 4 }));
  const generationDigest = hash(JSON.stringify({ family: 'model-generation-v1',
    manifest: generation.slice('urn:rezics:model-generation:'.length) }));
  const deps = { environment: { lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (sparql: string): Promise<SparqlResult> => {
      const uri = (value: string) => ({ type: 'uri', value }), lit = (value: string) => ({ type: 'literal', value });
      if (sparql.includes('SELECT ?generation WHERE')) return { results: { bindings: [{ generation: uri(generation) }] } };
      if (sparql.includes('SELECT ?manifest ?number ?predecessor')) return { results: { bindings: [{
        manifest: uri(`urn:rezics:sha256:${hash('model-manifest')}`), number: lit('1'),
        entailment: uri(RV + 'NoEntailment'), digest: lit(generationDigest),
      }] } };
      throw new Error(`Unexpected evidence page query: ${sparql.slice(0, 100)}`);
    },
  } }, access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://test/v1/relations/one?position=start'), {}, { ...basis.sourcePosition });
  const claim = { occurrence: { receipt: `urn:rezics:receipt:${hash('native-command')}`, manifest: `urn:rezics:sha256:${hash('native-bytes')}` },
    assertion: { statement: id(3), revision: id(4), coverage: { kind: 'occurrence', occurrence: id(1), occurrenceRevision: id(2) } },
    statement: null } as AssociationEvidenceClaim;
  const calls: { after: string | null; limit: number }[] = [];
  const owner: AssociationEvidenceSupportReader = {
    basis: async () => hash(JSON.stringify([support, quoteAllowed])),
    window: async (_session, _selection, _claim, after, limit) => {
      calls.push({ after, limit });
      const at = after === null ? 0 : Number(after.split(':').at(-1));
      const rows = source.slice(at, at + limit);
      return { items: rows.filter(row => row.visible).map(({ visible: _visible, ...row }) => ({ ...row,
        quote: quoteAllowed ? row.quote : null, quoteWithheld: !quoteAllowed })),
      after: at + rows.length < source.length ? `private-source-frontier:${at + rows.length}` : null,
      complete: at + rows.length >= source.length };
    },
  };
  return { session, claim, owner, calls, source,
    support: (value: string) => { support = value; }, quoteAllowed: (value: boolean) => { quoteAllowed = value; },
    generation: (value: string) => { generation = value; } };
}

test('evidence cursors bind the exact claim, occurrence, reader, selected Context, frames and position', () => {
  const token = issueAssociationEvidenceCursor(selection, basis, 'private-support-frontier', Date.now() + 60_000, id(9));
  expect(token.length).toBeLessThanOrEqual(2048);
  expect(token).not.toContain('private-support-frontier');
  expect(readAssociationEvidenceCursor(token, selection, basis)).toMatchObject({ after: 'private-support-frontier', lastEvidence: id(9) });
  for (const changed of [{ ...selection, claim: id(5) }, { ...selection, claimRevision: id(6) },
    { ...selection, occurrence: id(7) }, { ...selection, revision: id(8) }, { ...selection, context: id(9) },
    { ...selection, frame: [id(10)] }, { ...selection, position: 'all' }, { ...selection, limit: 3 }]) {
    expect(() => readAssociationEvidenceCursor(token, changed, basis)).toThrow(AssociationEvidenceCursorInvalid);
  }
  expect(() => assertAssociationEvidenceCursorBinding(token, selection, { subject: 'another' }, basis.sourcePosition))
    .toThrow(AssociationEvidenceCursorInvalid);
  expect(() => readAssociationEvidenceCursor('malformed', selection, basis)).toThrow(AssociationEvidenceCursorInvalid);
});

test('invalidated support, model, source position, restore or retention requires an exact GET restart', async () => {
  const token = issueAssociationEvidenceCursor(selection, basis, 'private', Date.now() + 60_000);
  const changes = [{ ...basis, modelGeneration: 'another-model' }, { ...basis, dependencies: { support: hash('withdrawn') } },
    { ...basis, sourcePosition: { ...basis.sourcePosition, sequence: '5' } },
    { ...basis, sourcePosition: { ...basis.sourcePosition, dataEpoch: 'restored' } }];
  for (const changed of changes) expect(() => readAssociationEvidenceCursor(token, selection, changed)).toThrow(AssociationEvidenceChanged);
  const expired = issueAssociationEvidenceCursor(selection, basis, 'private', Date.now() - 1);
  expect(() => readAssociationEvidenceCursor(expired, selection, basis)).toThrow(AssociationEvidenceChanged);
  const response = associationEvidenceFailure(new AssociationEvidenceChanged(selection))!;
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.code).toBe('stale_query_result');
  expect(body.restart.method).toBe('GET');
  const url = new URL(body.restart.path, 'http://test');
  expect(url.pathname).toBe(`/v1/relations/${id(1).split('/').at(-1)}/revisions/${id(2).split('/').at(-1)}`);
  expect(url.searchParams.get('claim')).toBe(selection.claim);
  expect(url.searchParams.get('position')).toBe(selection.position);
  expect(url.searchParams.has('cursor')).toBe(false);
});

test('physical hidden-only evidence windows continue without loss, duplication or a complete empty claim', async () => {
  const f = fixture(), collected: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const session = f.session();
    const result = await readAssociationEvidencePage(session, selection, f.claim, f.owner, cursor);
    expect(Value.Check(associationEvidenceResult, result)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(4);
    if (page === 0) { expect(result.items).toEqual([]); expect(result.complete).toBe(false); }
    collected.push(...result.items.map(item => item.id));
    await session.fenceDependencies();
    if (page < 2) { expect(result.nextCursor).not.toBeNull(); cursor = result.nextCursor!; }
    else { expect(result.complete).toBe(true); expect(result.nextCursor).toBeNull(); }
  }
  expect(collected).toEqual(f.source.filter(row => row.visible).map(row => row.id));
  expect(f.calls.every(call => call.limit === 4)).toBe(true);
  expect(f.calls.map(call => call.after)).toEqual([null, null, 'private-source-frontier:4', 'private-source-frontier:4',
    'private-source-frontier:8', 'private-source-frontier:8']);
});

test('support withdrawal and current quotation rights are reread at the completion fence', async () => {
  const f = fixture();
  const opening = await readAssociationEvidencePage(f.session(), selection, f.claim, f.owner);
  const session = f.session();
  const result = await readAssociationEvidencePage(session, selection, f.claim, f.owner, opening.nextCursor!);
  expect(result.items[0]?.quote).not.toBeNull();
  f.quoteAllowed(false);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, f.owner, opening.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
  const restarted = await readAssociationEvidencePage(f.session(), selection, f.claim, f.owner);
  const withheld = await readAssociationEvidencePage(f.session(), selection, f.claim, f.owner, restarted.nextCursor!);
  expect(withheld.items.every(item => item.quote === null && item.quoteWithheld)).toBe(true);
  const changed = f.session();
  await readAssociationEvidencePage(changed, selection, f.claim, f.owner, restarted.nextCursor!);
  f.support(hash('withdrawn-support'));
  await expect(changed.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, f.owner, restarted.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
});

test('missing coverage, overfilled/repeated evidence and nonadvancing frontiers refuse instead of certifying exhaustion', async () => {
  const f = fixture();
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, undefined)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.calls).toEqual([]);
  for (const page of [
    { items: Array.from({ length: 5 }, (_, i) => citation(i + 10)), after: null, complete: true },
    { items: [citation(10), citation(10)], after: null, complete: true },
    { items: [citation(11), citation(10)], after: null, complete: true },
    { items: [], after: null, complete: false },
    { items: [], after: 'obsolete', complete: true },
    { items: [{ ...citation(10), sourceWork: null }], after: null, complete: true },
  ]) {
    const owner = { ...f.owner, window: async () => page } as AssociationEvidenceSupportReader;
    await expect(readAssociationEvidencePage(f.session(), selection, f.claim, owner)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  const first = await readAssociationEvidencePage(f.session(), selection, f.claim, { ...f.owner,
    window: async () => ({ items: [citation(10)], after: 'physical:1', complete: false }) });
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, { ...f.owner,
    window: async () => ({ items: [citation(10)], after: null, complete: true }) }, first.nextCursor!))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('response and opaque frontier budgets fail explicitly without truncation', async () => {
  const f = fixture();
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, { ...f.owner,
    window: async () => ({ items: [{ ...citation(10), quote: 'x'.repeat(512 * 1024) }], after: null, complete: true }) }))
    .rejects.toThrow('response exceeds its bound');
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim, { ...f.owner,
    window: async () => ({ items: [], after: 'x'.repeat(1800), complete: false }) }))
    .rejects.toThrow('frontier exceeds its bound');
});

test('an occurrence without its independent adopted assertion is unavailable', async () => {
  const env = { query: async () => [] } as unknown as WorkReadSession;
  await expect(readAdoptedOccurrenceV2(env, id(1), id(2), 'global', [], async () => false)).rejects.toBeInstanceOf(StatementNotFound);
});

test('the opt-in evidence query has closed required selection and preserves the default relation authentication', async () => {
  expect(Value.Check(associationEvidenceQuery, query)).toBe(true);
  expect(selectAssociationEvidence(id(1), id(2), { ...query, limit: '4' })).toEqual(selection);
  for (const invalid of [{ ...query, limit: 17 }, { ...query, frame: Array.from({ length: 9 }, (_, i) => id(i + 10)) },
    { ...query, context: undefined }, { ...query, claimRevision: undefined }, { ...query, position: 'mine' },
    { ...query, unexpected: true }]) expect(Value.Check(associationEvidenceQuery, invalid)).toBe(false);
  let authentications = 0;
  const deps = { environment: { lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (sparql: string) => sparql.includes('ASK') ? { boolean: true } : { results: { bindings:
      sparql.includes('SELECT ?epoch ?sequence') ? [{ epoch: { type: 'literal', value: 'epoch-one' },
        sequence: { type: 'literal', value: '4' } }] : [] } },
  } }, access: { assertRecoveryOpen: async () => {} }, account: { verify: async () => {
    authentications++; throw new AccountAssertionDenied('Authentication required');
  } } } as unknown as MainWorkDependencies;
  const app = relationRoutes(deps.environment.fuseki, deps);
  const path = `http://test/v1/relations/${id(1).split('/').at(-1)}/revisions/${id(2).split('/').at(-1)}`;
  const old = await app.handle(new Request(`${path}?actingSubject=${id(8)}`));
  expect(old.status).toBe(401);
  expect(authentications).toBe(1);
  const params = new URLSearchParams(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])));
  const missing = await app.handle(new Request(`${path}?${params}`));
  expect(missing.status).toBe(404);
  expect(authentications).toBe(1);
  params.set('limit', '17');
  expect((await app.handle(new Request(`${path}?${params}`))).status).toBe(422);
});
