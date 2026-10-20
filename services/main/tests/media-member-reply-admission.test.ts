import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { AdmissionDenied, type AdmissionRequest, type GraphTerminalProof } from '../src/modules/access/admission.ts';
import { MediaConflict, MediaStale, MediaUnavailable, DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { DocumentImageUseInput } from '../src/modules/media/presentation.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { mediaRoutes } from '../src/routes/media.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** HTTP/owner composition with controlled Account/Access outcomes. The separate
 * SQL owner test exercises real Content drafts and Uses; this is no policy proof. */
function fixture() {
  const actor = native(), reply = native(), id = randomUUID(), use = randomUUID();
  const principal = { issuer: 'https://account.test', subject: 'member', emailVerified: true };
  const position = { owner: 'content' as const, dataEpoch: randomUUID(), sequence: '17' };
  const input: DocumentImageUseInput & { actingSubject: string } = { actingSubject: actor,
    target: reply, representation: randomUUID(), occurrence: randomUUID(), context: DEFAULT_MEDIA_CONTEXT, conceal: false,
    memberReplyDraft: { profile: 'member-reply-draft-image-v1', variantId: `urn:rezics:variant:${randomUUID()}`,
      expectedHead: randomUUID(), rootTarget: native(), rootRevision: native() } };
  const state = { scope: '', writes: 0, calls: 0, current: true, final: true, accountAllowed: true,
    fenceAvailable: true, held: false, sealed: false, lostSeal: false, stale: false,
    registered: null as AdmissionRequest | null,
    receipt: null as { outcome: 'succeeded' | 'stale_head'; position: typeof position } | null,
    terminal: null as GraphTerminalProof | null };
  const accessClient = {} as PoolClient;
  const fuseki = { query: async () => ({ boolean: true }) } as unknown as FusekiClient;
  const dependencies = { environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '0' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      state.scope = scopes.join(',');
      if (!state.accountAllowed) throw new AccountAssertionDenied();
      return principal;
    } },
    access: { activePrincipalId: async () => id,
      register: async (request: AdmissionRequest) => {
        if (!state.current) throw new AdmissionDenied('current member admission is denied');
        if (state.registered && state.registered.requestDigest !== request.requestDigest) throw new MediaConflict('key differs');
        const replayed = state.registered !== null;
        state.registered = request;
        return { ...request, id, principalId: id, authorityEpoch: '1', replayed, dispatchEligible: true,
          state: state.sealed ? 'sealed' : 'registered' };
      },
      claim: async () => { if (!state.current) throw new AdmissionDenied('claim denied'); },
      withOwnerAuthority: async <T>(request: AdmissionRequest, operation: (client: PoolClient) => Promise<T>) => {
        expect(request.principal).toBe(principal);
        expect(request.action).toBe('media.member-reply.use');
        if (!state.fenceAvailable) throw new MediaUnavailable('authority owner unavailable');
        state.held = true;
        try { return await operation(accessClient); } finally { state.held = false; }
      },
      fenceClaim: async (client: PoolClient, admission: string, digest: string, verified: typeof principal) => {
        expect(client).toBe(accessClient); expect(admission).toBe(id);
        expect(digest).toBe(state.registered!.requestDigest); expect(verified).toBe(principal);
        if (!state.final) throw new AdmissionDenied('authority changed before commit');
      },
      recordGraphOutcome: async (_admission: string, proof: GraphTerminalProof) => {
        if (state.lostSeal) { state.lostSeal = false; throw new Error('seal reply lost'); }
        state.terminal = proof; state.sealed = true;
      },
    },
    media: { store: { readOutcome: async () => state.receipt,
      presentation: { createDocumentUse: async (_admission: unknown, binding: DocumentImageUseInput) => {
        state.calls++;
        const replayed = state.receipt !== null;
        if (!replayed && binding.memberReplyDraft) expect(state.held).toBe(true);
        if (state.stale) {
          state.receipt = { outcome: 'stale_head', position };
          throw new MediaStale('draft head differs');
        }
        if (!replayed) state.writes++;
        state.receipt = { outcome: 'succeeded', position };
        return { use, asset: randomUUID(), representation: binding.representation,
          occurrence: binding.occurrence, position, replayed };
      } },
    } },
  } as unknown as MainWorkDependencies;
  const app = mediaRoutes(fuseki, dependencies);
  async function post(body = input) {
    const response = await app.handle(new Request('http://main.local/v1/media/uses', { method: 'POST',
      headers: { authorization: 'Bearer member', 'content-type': 'application/json', 'idempotency-key': 'member-image' },
      body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { state, input, actor, reply, id, use, position, post };
}

test('member image HTTP command uses comment scope and exact root metadata, with final authority and one replayed Use', async () => {
  const f = fixture();
  const created = await f.post();
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ use: f.use, representation: f.input.representation,
    occurrence: f.input.occurrence, admission: f.id, replayed: false, position: f.position });
  expect(f.state.scope).toBe('comment:create');
  expect(f.state.registered).toMatchObject({ action: 'media.member-reply.use', scope: `content:draft:${f.reply}`,
    actingSubject: f.actor, baselineRelatedWork: f.input.memberReplyDraft!.rootTarget,
    baselineSourceRevision: f.input.memberReplyDraft!.rootRevision });
  expect(f.state.terminal).toMatchObject({ outcome: 'succeeded',
    receipt: `urn:rezics:receipt:${sha(`${f.id}\0media-document-use`)}`, sequence: f.position.sequence });
  expect(await f.post()).toMatchObject({ status: 200, body: { use: f.use, replayed: true } });
  expect(f.state.writes).toBe(1);
  expect((await f.post({ ...f.input, occurrence: randomUUID() })).status).toBe(409);
  expect(f.state.writes).toBe(1);
});

test('legacy Work document image command retains its own scope and authority', async () => {
  const f = fixture();
  const { memberReplyDraft: _basis, ...legacy } = f.input;
  expect((await f.post(legacy)).status).toBe(201);
  expect(f.state.scope).toBe('work:edit');
  expect(f.state.registered).toMatchObject({ action: 'media.use', scope: `content:publish:${f.reply}` });
  expect(f.state.registered).not.toHaveProperty('baselineRelatedWork');
  expect(f.state.held).toBe(false);
});

for (const [name, change, status] of [
  ['Account scope refusal', (state: ReturnType<typeof fixture>['state']) => { state.accountAllowed = false; }, 401],
  ['current member refusal', (state: ReturnType<typeof fixture>['state']) => { state.current = false; }, 403],
  ['final authority refusal', (state: ReturnType<typeof fixture>['state']) => { state.final = false; }, 403],
  ['authority owner unavailable', (state: ReturnType<typeof fixture>['state']) => { state.fenceAvailable = false; }, 503],
] as const) test(`${name} creates no image Use`, async () => {
  const f = fixture(); change(f.state);
  expect((await f.post()).status).toBe(status);
  expect(f.state.writes).toBe(0);
  expect(f.state.receipt).toBeNull();
});

test('lost Access acknowledgment recovers the exact durable Use without a second write', async () => {
  const f = fixture(); f.state.lostSeal = true;
  expect((await f.post()).status).toBe(503);
  expect(await f.post()).toMatchObject({ status: 200, body: { use: f.use, replayed: true } });
  expect(f.state.writes).toBe(1);
  f.state.current = false;
  expect((await f.post()).status).toBe(403);
  expect(f.state.writes).toBe(1);
});

test('stale owner result remains an HTTP stale refusal and seals its actual cancelled receipt', async () => {
  const f = fixture(); f.state.stale = true;
  expect((await f.post()).status).toBe(409);
  expect((await f.post()).status).toBe(409);
  expect(f.state.terminal).toMatchObject({ outcome: 'cancelled', dataEpoch: f.position.dataEpoch, sequence: f.position.sequence });
  expect(f.state.writes).toBe(0);
});
