import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { projectSubjectOffer, advanceSubjectOfferBootstrap } from '../../src/commerce/subject-offer-work.ts';
import type { SubjectOffersPage } from '../../src/commerce/model.ts';
import { seedGovernanceAuthority, seedResourceDenial } from '../content/support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let native: NativeContentSystem;
let app: Kernel;
let subject: string;
let edition: string;
let offer: { id: string; revision: number };
async function wire(
  path: string,
  method = 'GET',
  body?: unknown,
  bearer: string | null = native.actors.author.bearer,
  version?: string,
) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
        ...(version ? { 'if-match': JSON.stringify(version) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function value<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response;
  const text = await result.text();
  expect({ status: result.status, error: result.status === status ? null : text }).toEqual({ status, error: null });
  return JSON.parse(text) as T;
}
const path = () => `/v1/subjects/${subject}/offers`;
const project = () => projectSubjectOffer(native.database.pool, offer.id, Date.now() + 20_000);

beforeAll(async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  await bootstrapRelease(native.database.pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  app = createKernel({
    pool: native.database.pool,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: native.access,
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  const account = native.actors.author.actor.accountId;
  await seedGovernanceAuthority(native.database.pool, 0, PLATFORM_RESOURCE.id, account, ['exposure:open']);
  await seedGovernanceAuthority(native.database.pool, 0, GLOBAL_CONTEXT, account, ['offer:create', 'moderation:hide']);
  for (const group of ['selling', 'purchases'])
    await value(wire(`/v1/platform/exposure/${group}:open`, 'POST', {}), 200);
  const scheme = await value<{ subject: { id: string } }>(
    wire('/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Offer topics' },
    }),
    201,
  );
  const concept = await value<{ subject: { id: string } }>(
    wire('/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Offered edition' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    }),
    201,
  );
  subject = concept.subject.id;
  const space = await value<{ space: { spaceId: string } }>(wire('/v1/spaces', 'POST', { title: 'Offer home' }), 201);
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    wire('/v1/realms', 'POST', {
      spaceId: space.space.spaceId,
      title: 'Offer realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
    201,
  );
  await value(
    wire(
      `/v1/realms/${realm.realm.realmId}/boardScheme`,
      'PUT',
      { schemeId: scheme.subject.id },
      native.actors.author.bearer,
      realm.realm.headRevisionId,
    ),
    200,
  );
  const board = await value<{ board: { id: string } }>(
    wire(`/v1/realms/${realm.realm.realmId}/boards`, 'POST', {
      conceptId: subject,
      title: 'Offer board',
      visibility: 'published',
    }),
    201,
  );
  const thread = await value<{ thread: { firstPost: { id: string; revisionId: string } } }>(
    wire('/v1/threads', 'POST', {
      title: 'Public native source',
      body: fromPlainText('Actual fixed edition'),
      licence: 'CC0-1.0',
      subjectIds: [subject],
      boardId: board.board.id,
      visibility: 'published',
    }),
    201,
  );
  const draft = await value<{ editionId: string }>(
    wire('/v1/contentEditions', 'POST', {
      postId: thread.thread.firstPost.id,
      revisionId: thread.thread.firstPost.revisionId,
      targetSubjectId: subject,
    }),
    201,
  );
  edition = draft.editionId;
  await value(wire(`/v1/contentEditions/${edition}:publish`, 'POST', {}, native.actors.author.bearer, '1'), 200);
  const created = await value<{ offer: typeof offer }>(
    wire('/v1/offers', 'POST', {
      contentEditionId: edition,
      title: 'Current public terms',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    }),
    201,
  );
  // Mutation views deliberately omit revision; the ordinary public offer read supplies it.
  offer = (await value<{ offer: typeof offer }>(wire(`/v1/offers/${created.offer.id}`), 200)).offer;
}, 120_000);
afterAll(async () => {
  await native?.close();
});

test('Bounded real subject-to-offer discovery with current positive confirmation', async () => {
  const pool = native.database.pool;
  // No projection does not claim complete absence, even with actual native Subject authority.
  expect(await value<SubjectOffersPage>(wire(path(), 'GET', undefined, null), 200)).toEqual({
    offers: [],
    next: null,
    projectionState: 'preparing',
  });
  await project();
  await project(); // duplicate native outbox delivery has one reference
  const listed = await value<SubjectOffersPage>(wire(path(), 'GET', undefined, null), 200);
  expect(listed.projectionState).toBe('preparing');
  expect(listed.offers).toHaveLength(1);
  expect(Object.keys(listed.offers[0]!).sort()).toEqual([
    'contentEdition',
    'currency',
    'id',
    'moneyUnit',
    'revision',
    'targetSubjectId',
    'taxBehavior',
    'title',
    'unitAmountMinor',
  ]);
  expect(listed.offers[0]).toMatchObject({
    id: offer.id,
    revision: offer.revision,
    title: 'Current public terms',
    unitAmountMinor: 1200,
  });
  expect(listed.offers[0]!.contentEdition?.source).toEqual({ licence: 'CC0-1.0' });
  expect(JSON.stringify(listed)).not.toContain('postId');
  expect((await wire(path(), 'GET', undefined, null)).headers.get('cache-control')).toBe('private, no-store');
  expect((await value<SubjectOffersPage>(wire(path()), 200)).offers.map((item) => item.id)).toEqual([offer.id]);

  const first = await value<SubjectOffersPage>(wire(`${path()}?limit=1`, 'GET', undefined, null), 200);
  expect(first.next).not.toBeNull();
  expect(
    (
      await value<SubjectOffersPage>(
        wire(`${path()}?limit=1&cursor=${encodeURIComponent(first.next!)}`, 'GET', undefined, null),
        200,
      )
    ).offers,
  ).toEqual([]);
  expect((await wire(`${path()}?cursor=forged`, 'GET', undefined, null)).status).toBe(400);
  expect((await wire(`${path()}?limit=21`, 'GET', undefined, null)).status).toBe(422);
  expect(
    (await wire(`${path()}?buyerAccountId=${native.actors.author.actor.accountId}`, 'GET', undefined, null)).status,
  ).toBe(422);

  // Named signed-in denial remains a denial even though the anonymous floor is positive.
  await seedResourceDenial(pool, routeOf(subject)!, subject, native.actors.other.actor.accountId, ['subject:read']);
  expect((await wire(path(), 'GET', undefined, native.actors.other.bearer)).status).toBe(404);
  expect((await value<SubjectOffersPage>(wire(path(), 'GET', undefined, null), 200)).offers).toHaveLength(1);

  const home = partitionOf(routeOf(offer.id)!);
  await pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [home]);
  try {
    const unavailable = await wire(path(), 'GET', undefined, null);
    // Colocated Subject/directory authority may itself be unavailable; it cannot fabricate ready empty.
    if (unavailable.status === 200)
      expect(await unavailable.json()).toMatchObject({ offers: [], projectionState: 'preparing' });
    else expect(unavailable.status).toBe(503);
  } finally {
    await pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [home]);
  }

  await value(wire(`/v1/offers/${offer.id}:delist`, 'POST', { expectedRevision: 1 }), 200);
  // A stale listed reference is rejected before outbox delivery; rejects still advance raw cursor.
  const stale = await value<SubjectOffersPage>(wire(`${path()}?limit=1`, 'GET', undefined, null), 200);
  expect(stale.offers).toEqual([]);
  expect(stale.next).not.toBeNull();
  await project();
  await project();
  expect((await value<SubjectOffersPage>(wire(path(), 'GET', undefined, null), 200)).offers).toEqual([]);

  // The default native recovery caller advances one bounded source page with a scalar CAS frontier.
  await advanceSubjectOfferBootstrap(pool, Date.now() + 20_000);
  const state = await pool.query('SELECT frontier,version FROM commerce.subject_offer_bootstrap WHERE partition_no=0');
  expect(BigInt(state.rows[0].version)).toBeGreaterThan(1n);
  expect(typeof state.rows[0].frontier).toBe('string');
  await value(wire(`/v1/subjects/${subject}:hide`, 'POST', { reason: 'Hide native offer subject' }), 200);
  expect((await wire(path(), 'GET', undefined, null)).status).toBe(404);
}, 120_000);
