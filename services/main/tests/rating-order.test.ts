import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { AdmissionRequest, RegisteredAdmission } from '../src/modules/access/admission.ts';
import { ReaderLibraryRatings } from '../src/modules/library/ratings.ts';
import { GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION_OWNER, globalRatingDigest }
  from '../src/modules/rating/global.ts';
import { standingRatingReceiptIri, standingRatingSlotIri } from '../src/modules/rating/observation.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { globalRatingRoutes } from '../src/routes/rating-global.ts';

const id = (n: number) => `https://rezics.com/id/019cb49e-0ea2-7000-8000-${String(n).padStart(12, '0')}`;
const context = id(1), work = id(2), mainVersion = id(3), actor = id(4), observation = id(5);
const principalId = '019cb49e-0ea2-7000-8000-000000000099';
const slot = standingRatingSlotIri(principalId, context, mainVersion);
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const sourcePosition = (sequence: string) => ({ datasetId: 'product', dataEpoch: 'epoch-1', sequence });

/** Sealed owner receipts and immutable manifests: test the API adapters without replacing owner functions. */
function fixture() {
  const scratch = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'rating-order-'));
  const principal = { issuer: 'account', subject: 'reader', emailVerified: true };
  const receipts = new Map<string, Row>();
  const registered = new Map<string, RegisteredAdmission>();
  const revisions = new Map<string, Row>();
  let head: string | null = null;
  let inventoryHead: string | null = null;
  let authority = true, eraseHead = false;
  const body = (value: number | null, expectedRevisionHead: string | null) => ({
    profile: 'global-rating-standing-observation-v1', context, work, mainVersion,
    actingSubject: actor, value, expectedRevisionHead,
  });
  const seal = (key: string, value: number | null, predecessor: string | null, sequence: string, stale = false) => {
    const input = body(value, predecessor), admissionId = id(100 + registered.size).slice(-36);
    const digest = globalRatingDigest(input), receipt = standingRatingReceiptIri(admissionId);
    const revision = id(200 + registered.size);
    registered.set(key, { id: admissionId, principalId, actingSubject: actor, scope: `rating:observe:${context}`,
      action: 'rating.observation.set', idempotencyKey: key, requestDigest: digest, authorityEpoch: '1',
      expiresAt: '2099-01-01T00:00:00.000Z', state: 'sealed', dispatchEligible: false, replayed: false });
    const common = { digest: literal(digest), id: literal(admissionId), epoch: literal('1'),
      scope: literal(`rating:observe:${context}`), dataEpoch: literal('epoch-1'), sequence: literal(sequence) };
    if (stale) {
      receipts.set(receipt, { ...common, outcome: uri(`${RV}Cancelled`), reason: uri(`${RV}StaleHead`) });
      return revision;
    }
    const availability = value === null ? 'withdrawn' : 'available';
    const time = '2026-10-07T00:00:00.000Z';
    const manifest = prepareComponent(directory, observation, { observation, slot, context,
      contextRevision: id(6), populationOwner: GLOBAL_RATING_POPULATION_OWNER, work, mainVersion,
      revision, predecessor, availability, value, evaluatedAt: time, submittedAt: time,
      originalSubmissionAt: time, revisedAt: time }, GLOBAL_OBSERVATION_PROFILE);
    const rating = { availability: uri(`${RV}${value === null ? 'Withdrawn' : 'Available'}`),
      ...(value === null ? {} : { value: literal(String(value)) }) };
    receipts.set(receipt, { ...common, outcome: uri(`${RV}Succeeded`), operation: uri(id(300 + registered.size)),
      realm: uri(GLOBAL_RATING_POPULATION_OWNER), context: uri(context), contextRevision: uri(id(6)),
      work: uri(work), main: uri(mainVersion), slot: uri(slot), observation: uri(observation),
      revision: uri(revision), ...(predecessor ? { predecessor: uri(predecessor) } : {}), ...rating });
    revisions.set(revision, { ...rating, manifest: uri(`urn:rezics:sha256:${manifest}`),
      dataEpoch: literal('epoch-1'), sequence: literal(sequence), receipt: uri(receipt), digest: literal(digest) });
    head = inventoryHead = revision;
    return revision;
  };
  const fuseki = { query: async (sparql: string): Promise<SparqlResult> => {
    if (sparql.includes('ASK')) return { boolean: true };
    if (sparql.includes('SELECT ?head ?dataEpoch ?sequence')) {
      expect(sparql).toContain(slot);
      return { results: { bindings: head ? [{ head: uri(head), ...!eraseHead ? {
        dataEpoch: revisions.get(head)!.dataEpoch!, sequence: revisions.get(head)!.sequence! } : {} }] : [] } };
    }
    const receipt = [...receipts.keys()].find(key => sparql.includes(`<${key}>`));
    if (!receipt) throw new Error('Unexpected graph query');
    return { results: { bindings: [receipts.get(receipt)!] } };
  } };
  const deps = { environment: { fuseki, lineage: { dataEpoch: 'epoch-1', routingEpoch: '1' }, objectDirectory: directory },
    account: { verify: async () => principal },
    access: { register: async (request: AdmissionRequest) => {
      const admission = registered.get(request.idempotencyKey)!;
      expect(request.principal).toEqual(principal);
      expect(request.requestDigest).toBe(admission.requestDigest);
      return admission;
    }, recordGraphOutcome: async () => {}, activePrincipalId: async () => principalId,
    canReadAsBaselineMember: async () => authority },
  } as unknown as MainWorkDependencies;
  const app = globalRatingRoutes(deps);
  const send = (key: string, value: number | null, predecessor: string | null, device = 'first') =>
    app.handle(new Request('http://main.local/v1/global-rating-observations', { method: 'POST',
      headers: { authorization: `Bearer ${device}`, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body(value, predecessor)) }));
  const pool = { query: async (sql: string, args: unknown[]) => {
    expect(sql).toContain('h.principal_id = $1');
    expect(args).toEqual([principalId, [context], [work]]);
    if (!inventoryHead) return { rows: [] };
    const row = revisions.get(inventoryHead)!;
    return { rows: [{ context, work, main_version: mainVersion, observation, revision: inventoryHead, slot,
      receipt: row.receipt!.value, digest: row.digest!.value, valid: true }] };
  } } as unknown as Pool;
  const session = { deps, principal, options: { actingSubject: actor }, request: new Request('http://main.local'),
    query: async (sparql: string) => {
      if (sparql.includes('SELECT ?kind ?context')) return [{ kind: literal('global'), context: uri(context) }];
      expect(sparql).toContain('rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence');
      return [{ ...revisions.get(inventoryHead!)!, currentHead: uri(head!) }];
    } } as unknown as WorkReadSession;
  const own = async () => (await new ReaderLibraryRatings(pool).read(session, [{ work, main: mainVersion }])).get(work)!.global!;
  return { seal, send, own, registered, revisions,
    lagAt(revision: string) { inventoryHead = revision; },
    deny() { authority = false; }, erase() { eraseHead = true; },
    close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('rating API preserves sealed revision order across two writers and replay, including a lagging library read', async () => {
  const f = fixture();
  try {
    const firstRevision = f.seal('first', 3, null, '9007199254740992');
    const first = await f.send('first', 3, null);
    expect(first.status).toBe(201);
    const firstState = await first.json();
    expect(firstState.sourcePosition).toEqual(sourcePosition('9007199254740992'));
    expect(await f.own()).toMatchObject({ revision: firstRevision, value: 3, sourcePosition: firstState.sourcePosition, stale: false });
    const secondRevision = f.seal('second', 5, firstRevision, '9007199254740993');
    const second = await f.send('second', 5, firstRevision, 'second');
    expect(second.status).toBe(201);
    const secondState = await second.json();
    expect(BigInt(secondState.sourcePosition.sequence)).toBeGreaterThan(BigInt(firstState.sourcePosition.sequence));
    expect(await f.own()).toMatchObject({ revision: secondRevision, value: 5, sourcePosition: secondState.sourcePosition });
    f.registered.get('first')!.replayed = true;
    const replay = await f.send('first', 3, null);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ observationRevision: firstRevision,
      sourcePosition: firstState.sourcePosition, replayed: true });
    f.lagAt(firstRevision);
    expect(await f.own()).toMatchObject({ revision: firstRevision, value: 3, sourcePosition: firstState.sourcePosition, stale: true });
  } finally { f.close(); }
});

test('rating stale_head returns the current revision position, never the refusal or replay position', async () => {
  const f = fixture();
  try {
    const head = f.seal('first', 5, null, '7');
    f.seal('stale', 3, null, '8', true);
    for (const replayed of [false, true]) {
      f.registered.get('stale')!.replayed = replayed;
      const response = await f.send('stale', 3, null);
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'stale_head', currentHead: head, sourcePosition: sourcePosition('7') });
    }
  } finally { f.close(); }
});

test.each(['denied', 'erased'] as const)('rating stale_head does not expose a %s head', async state => {
  const f = fixture();
  try {
    f.seal('first', 5, null, '7');
    f.seal('stale', 3, null, '8', true);
    if (state === 'denied') f.deny(); else f.erase();
    const response = await f.send('stale', 3, null);
    expect(response.status).toBe(state === 'denied' ? 403 : 503);
    expect(await response.json()).not.toHaveProperty('currentHead');
  } finally { f.close(); }
});

test('rating library rejects missing or malformed revision positions instead of inventing an order', async () => {
  const f = fixture();
  try {
    const revision = f.seal('first', 5, null, '7');
    for (const sequence of ['', '-1', '1.5']) {
      f.revisions.get(revision)!.sequence = literal(sequence);
      await expect(f.own()).rejects.toThrow('Rating revision position is unavailable');
    }
  } finally { f.close(); }
});
