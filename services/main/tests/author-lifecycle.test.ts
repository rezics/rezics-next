import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore } from '../../content/src/core.ts';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { ClaimedAdmission } from '../src/modules/access/admission.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  ContentEligibilityDenied, ContentEligibilityStale, selectPublicContentSearch,
  type ContentSearchEligibilityWithdrawalInput } from '../src/modules/content-publication/eligibility.ts';
import { selectAdmittedPublicContentSearch } from '../src/modules/content-publication/eligibility-admitted.ts';
import { classifyContentEligibilityState } from '../src/modules/content-publication/eligibility-state.ts';
import { RealmReplyContentStore, RealmReplyDenied } from '../src/modules/realm-reply/content-store.ts';
import { assertPlacementWithdrawalOwner, withdrawReplyPlacement } from '../src/modules/realm-reply/graph.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { mapContentOutboxEvent, OutboxIncomplete, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { ID, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const noContent = {} as ContentCore;
const noDraftProof = { verifyContentDraftProof: async () => { throw new Error('withdrawal must not require draft bytes'); } };

function fixture() {
  const input: ContentSearchEligibilityWithdrawalInput = {
    profile: 'content-search-eligibility-withdrawal-v1', resourceId: ID + randomUUID(),
    variantId: `urn:rezics:variant:${randomUUID()}`, publicationDecision: `urn:rezics:content-publication:${randomUUID()}`,
    expectedEligibilityHead: `urn:rezics:content-search-eligibility:${randomUUID()}`, actingSubject: ID + randomUUID(),
  };
  const admission: ClaimedAdmission = { id: randomUUID(), principalId: randomUUID(), actingSubject: input.actingSubject,
    action: 'content.search-eligibility', scope: `content:search-eligibility:${input.resourceId}`,
    requestDigest: contentSearchEligibilityDigest(input), idempotencyKey: randomUUID(), authorityEpoch: '2',
    state: 'claimed', dispatchEligible: true, replayed: false, claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const dataEpoch = randomUUID();
  class Graph extends FusekiClient {
    owner = true;
    head = input.expectedEligibilityHead;
    receipt: SparqlResult['results'] = { bindings: [] };
    commands: CommandEnvelope[] = [];
    constructor() { super('http://localhost:1/rezics'); }
    override async commandHealth() { return { moduleVersion: COMMAND_MODULE_VERSION,
      instanceId: randomUUID(), publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, value]) => [key, value.sha256])) }; }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('ASK')) return { boolean: query.includes('qualification') ? this.owner
        : query.includes('rv:actingSubject') || query.includes('rv:decidedBy') ? this.owner : true };
      if (query.includes('SELECT ?head')) return { results: { bindings: [{ head: uri(this.head) }] } };
      return { results: this.receipt };
    }
    override async commandWithReceipt(command: CommandEnvelope): Promise<never> {
      this.commands.push(command);
      const stale = command.update.includes('rv:outcome rv:Cancelled');
      const decision = contentSearchEligibilityDecisionIri(admission.id, true);
      this.receipt = { bindings: [{ outcome: uri(RV + (stale ? 'Cancelled' : 'Succeeded')),
        ...(stale ? { reason: uri(RV + 'StaleHead') } : { decision: uri(decision) }),
        digest: literal(admission.requestDigest), id: literal(admission.id), authority: literal(admission.authorityEpoch),
        scope: literal(admission.scope), actor: uri(input.actingSubject), resource: uri(input.resourceId),
        variant: uri(input.variantId), publication: uri(input.publicationDecision), expected: uri(input.expectedEligibilityHead),
        withdrawn: uri(input.expectedEligibilityHead), epoch: literal(dataEpoch), sequence: literal('11') }] };
      if (!stale) this.head = decision;
      throw new Error('response lost after the graph committed');
    }
  }
  const graph = new Graph();
  const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch, routingEpoch: '1' }, objectDirectory: '.temp' };
  return { input, admission, graph, env };
}

test('author qualification withdrawal resolves its exact durable receipt after transport loss and later head movement', async () => {
  const f = fixture();
  const result = await selectPublicContentSearch(f.env, noContent, noDraftProof, f.admission, f.input);
  expect(result).toMatchObject({ profile: f.input.profile, outcome: 'succeeded', resourceId: f.input.resourceId,
    variantId: f.input.variantId, publicationDecision: f.input.publicationDecision,
    withdrawnEligibilityHead: f.input.expectedEligibilityHead, decision: ID + f.admission.id,
    graphDataEpoch: f.env.lineage.dataEpoch, graphSequence: '11', replayed: false });
  f.graph.head = ID + randomUUID();
  expect(await selectPublicContentSearch(f.env, noContent, noDraftProof, f.admission, f.input))
    .toEqual({ ...result, replayed: true });
  expect(f.graph.commands).toHaveLength(1);
});

test('an obsolete qualification records and replays a durable stale outcome without changing the current head', async () => {
  const f = fixture(), moved = ID + randomUUID();
  f.graph.head = moved;
  await expect(selectPublicContentSearch(f.env, noContent, noDraftProof, f.admission, f.input))
    .rejects.toBeInstanceOf(ContentEligibilityStale);
  await expect(selectPublicContentSearch(f.env, noContent, noDraftProof, f.admission, f.input))
    .rejects.toBeInstanceOf(ContentEligibilityStale);
  expect(f.graph.commands).toHaveLength(1);
  expect(f.graph.head).toBe(moved);
});

test('author withdrawal rejects someone else’s qualification before writing or reading Content bytes', async () => {
  const f = fixture();
  f.graph.owner = false;
  await expect(selectPublicContentSearch(f.env, noContent, noDraftProof, f.admission, f.input))
    .rejects.toBeInstanceOf(ContentEligibilityDenied);
  expect(f.graph.commands).toHaveLength(0);
});

test('withdrawal replay still requires live Agent control and stale receipts reach the existing Access sealer', async () => {
  const f = fixture();
  const principal = { id: f.admission.principalId } as never;
  let live = true, sealed = 0;
  const access = { ...noDraftProof, register: async () => f.admission, claim: async () => f.admission,
    recordGraphOutcome: async () => { sealed++; },
    withOwnerAuthority: async <T>(_input: unknown, action: (client: PoolClient) => Promise<T>): Promise<T> => {
      if (!live) throw new AdmissionDenied('Agent control revoked');
      return action({} as PoolClient);
    } };
  const call = () => selectAdmittedPublicContentSearch(f.env, noContent,
    { verify: async () => principal }, access, new Request('http://localhost/'),
    { ...f.input, idempotencyKey: f.admission.idempotencyKey });
  await call();
  live = false;
  await expect(call()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(sealed).toBe(1);
  const stale = fixture();
  stale.graph.head = ID + randomUUID();
  access.register = async () => stale.admission;
  access.claim = async () => stale.admission;
  live = true;
  await expect(selectAdmittedPublicContentSearch(stale.env, noContent,
    { verify: async () => principal }, access, new Request('http://localhost/'),
    { ...stale.input, idempotencyKey: stale.admission.idempotencyKey })).rejects.toBeInstanceOf(ContentEligibilityStale);
  expect(sealed).toBe(2);
});

test('qualification withdrawal is a proved closed head and never an absent or positive approval', () => {
  const f = fixture();
  const publication = { id: f.input.publicationDecision, variant: f.input.variantId,
    resource: f.input.resourceId, revision: `urn:rezics:content:revision:${randomUUID()}`, digest: 'a'.repeat(64),
    ownerDataEpoch: randomUUID(), ownerSequence: '3', graphSequence: '5' };
  const decision = ID + f.admission.id;
  const evidence = { snapshot: { ...f.env.lineage, sequence: '11' },
    owner: { dataEpoch: publication.ownerDataEpoch, sequence: '3' }, variant: f.input.variantId,
    resourceCount: 1, resource: uri(f.input.resourceId), publicationCount: 1, publication: uri(publication.id),
    eligibilityCount: 1, eligibility: uri(decision), currentPublication: publication, approvedPublication: publication,
    eligibilityProof: { id: decision, variant: f.input.variantId, resource: f.input.resourceId,
      publicationDecision: publication.id, graphSequence: '11', rightsBasis: '',
      withdrawnEligibilityHead: f.input.expectedEligibilityHead }, restoreOpen: true };
  expect(classifyContentEligibilityState(evidence)).toMatchObject({ kind: 'closed-withdrawn',
    id: publication.id, eligibilityDecision: decision, withdrawnEligibilityHead: f.input.expectedEligibilityHead });
  expect(classifyContentEligibilityState({ ...evidence, eligibilityProof: undefined }).kind).toBe('unresolved');
});

test('placement withdrawal checks retained publisher and author, and mismatched exact revision cancels without profile dispatch', async () => {
  const f = fixture();
  const input = { realm: ID + randomUUID(), reply: ID + randomUUID(), expectedHead: ID + randomUUID(),
    expectedRevisionId: randomUUID() };
  f.graph.owner = false;
  await expect(assertPlacementWithdrawalOwner(f.env, f.input.actingSubject, input)).rejects.toBeInstanceOf(RealmReplyDenied);
  const admission = { ...f.admission, action: 'reply.place', scope: `reply:place:${input.realm}` };
  let commands = 0, receipt = false;
  f.graph.query = async (query: string) => query.includes('?placement ?revision ?review')
    ? { results: { bindings: [{ placement: uri(input.expectedHead), revision: uri(`urn:rezics:content:revision:${randomUUID()}`),
      review: uri(`urn:rezics:realm-review:${randomUUID()}`), root: uri(ID + randomUUID()),
      rootRevision: literal(ID + randomUUID()), author: uri(f.input.actingSubject), preparation: literal(randomUUID()) }] } }
    : { results: { bindings: receipt ? [{ outcome: uri(RV + 'Cancelled'), digest: literal(admission.requestDigest),
      id: literal(admission.id), epoch: literal(admission.authorityEpoch), scope: literal(admission.scope),
      dataEpoch: literal(f.env.lineage.dataEpoch), sequence: literal('12') }] : [] } };
  f.graph.commandWithReceipt = async () => { commands++; receipt = true; throw new Error('lost acknowledgement'); };
  expect(await withdrawReplyPlacement(f.env, admission, input)).toMatchObject({ outcome: 'cancelled', sequence: '12' });
  expect(commands).toBe(1);
});

test('independent reply public bytes stay at the identity receipt while exact reads can select a placement revision', async () => {
  const reply = ID + randomUUID(), publishedRevision = randomUUID(), selectedRevision = randomUUID();
  const pool = { query: async (query: string, args: unknown[]) => {
    expect(query).not.toContain('discovery_revision(v.draft_head) r');
    expect(query).toContain("live.body->>'deleted'='false'");
    expect(query).toContain('published.revision_id');
    return { rows: [{ reply, revisionId: args[1] ?? publishedRevision, body: 'Published words.',
      document: null, spoiler: null }] };
  } } as unknown as Pool;
  const content = new RealmReplyContentStore(pool);
  expect((await content.readCurrent(reply))?.revisionId).toBe(publishedRevision);
  expect((await content.readCurrent(reply, selectedRevision))?.revisionId).toBe(selectedRevision);
});

test('placement withdrawal retains its exact predecessor and bytes across lost acknowledgements and a later placement', async () => {
  const f = fixture();
  const input = { realm: ID + randomUUID(), reply: ID + randomUUID(), expectedHead: ID + randomUUID(),
    expectedRevisionId: randomUUID() };
  const admission = { ...f.admission, action: 'reply.place', scope: `reply:place:${input.realm}` };
  let saved = false, headReads = 0;
  f.graph.query = async (query: string) => {
    if (query.includes('?placement ?revision ?review')) {
      headReads++;
      return { results: { bindings: [{ placement: uri(input.expectedHead),
        revision: uri(`urn:rezics:content:revision:${input.expectedRevisionId}`),
        review: uri(`urn:rezics:realm-review:${randomUUID()}`), root: uri(ID + randomUUID()),
        rootRevision: literal(ID + randomUUID()), author: uri(f.input.actingSubject), preparation: literal(randomUUID()) }] } };
    }
    return { results: { bindings: saved ? [{ outcome: uri(RV + 'Succeeded'), digest: literal(admission.requestDigest),
      id: literal(admission.id), epoch: literal(admission.authorityEpoch), scope: literal(admission.scope),
      dataEpoch: literal(f.env.lineage.dataEpoch), sequence: literal('12'), placement: uri(ID + admission.id),
      revision: uri(`urn:rezics:content:revision:${input.expectedRevisionId}`), realm: uri(input.realm),
      reply: uri(input.reply), predecessor: uri(input.expectedHead) }] : [] } };
  };
  f.graph.commandWithReceipt = async command => {
    f.graph.commands.push(command);
    expect(command.update).toContain('rv:placementOutcome rv:Revoked');
    expect(command.update).toContain(`rv:previousPlacement <${input.expectedHead}>`);
    expect(command.update).toContain('rv:author rv:parentReply rv:parentRevision');
    expect(command.validations).toHaveLength(2);
    saved = true;
    throw new Error('response lost after withdrawal committed');
  };
  const result = await withdrawReplyPlacement(f.env, admission, input);
  expect(result).toMatchObject({ outcome: 'succeeded', placement: ID + admission.id,
    realm: input.realm, reply: input.reply, predecessor: input.expectedHead, revisionId: input.expectedRevisionId });
  expect(await withdrawReplyPlacement(f.env, admission, input)).toEqual(result);
  expect(headReads).toBe(1);
  expect(f.graph.commands).toHaveLength(1);
});

test('retained reply author history requires current control of its immutable author', async () => {
  const f = fixture(), reply = ID + randomUUID(), revision = randomUUID();
  const content = { revisionAuthor: async (_reply: string, id: string) => id === revision
    ? { author: f.input.actingSubject, rootTarget: 'urn:unsupported:root', rootRevision: 'urn:unsupported:revision' } : null,
  } as unknown as RealmReplyContentStore;
  let live = true, controls = 0;
  const access = { withOwnerAuthority: async <T>(_input: unknown, action: (client: PoolClient) => Promise<T>) => {
    controls++;
    if (!live) throw new AdmissionDenied('Agent control revoked');
    return action({} as PoolClient);
  } };
  const store = new RealmReplyStore(content, noContent, access as never, f.env);
  store.readPublic = async () => null;
  const principal = { id: f.admission.principalId } as never;
  expect(await store.canReadRevision(reply, revision, principal, f.input.actingSubject)).toBe(true);
  expect(await store.canReadRevision(reply, revision, principal, ID + randomUUID())).toBe(false);
  expect(await store.canReadRevision(reply, randomUUID(), principal, f.input.actingSubject)).toBe(false);
  live = false;
  expect(await store.canReadRevision(reply, revision, principal, f.input.actingSubject)).toBe(false);
  expect(controls).toBe(2);
});

test('withdrawal outbox events retain the exact qualification target and cannot masquerade as public approval', () => {
  const f = fixture();
  const eventId = `urn:rezics:event:${randomUUID()}`;
  const batch: MainOutboxBatch = { batchId: `urn:rezics:outbox:${randomUUID()}`, dataEpoch: f.env.lineage.dataEpoch,
    routingEpoch: '1', sequence: '11', eventIds: [eventId] };
  const fields: Record<string, string> = { kind: RV + 'ContentSearchEligibilityWithdrawalEvent', action: 'content.search-eligibility',
    outcome: RV + 'Succeeded', receipt: `urn:rezics:receipt:${randomUUID()}`, digest: f.admission.requestDigest,
    epoch: batch.dataEpoch, sequence: batch.sequence, admissionId: f.admission.id, authorityEpoch: '2', scope: f.admission.scope,
    resource: f.input.resourceId, variant: f.input.variantId, eventVariant: f.input.variantId,
    publicationDecision: f.input.publicationDecision, eventPublicationDecision: f.input.publicationDecision,
    eligibilityDecision: ID + f.admission.id, actingSubject: f.input.actingSubject,
    withdrawnEligibilityHead: f.input.expectedEligibilityHead };
  expect(mapContentOutboxEvent(batch, eventId, name => fields[name], 0)).toMatchObject({
    type: 'com.rezics.content.search-eligibility-withdrawn.v1', data: { receipt: {
      withdrawnEligibilityHead: f.input.expectedEligibilityHead } } });
  fields.disclosure = RV + 'Public';
  expect(() => mapContentOutboxEvent(batch, eventId, name => fields[name], 0)).toThrow(OutboxIncomplete);
});
