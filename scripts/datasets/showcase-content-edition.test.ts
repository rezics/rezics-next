import { expect, test } from 'bun:test';
import type {
  DevelopmentCommandIntent,
  DevelopmentCommunityOutcome,
  DevelopmentSeedStep,
  DevelopmentShowcaseClient,
} from './showcase-community.ts';
import { seedDevelopmentContentEdition } from './showcase-content-edition.ts';
import { seedDevelopmentContentEditionOffer } from './showcase-commerce-offer.ts';
import { routeOf } from '../../services/kernel/src/route/route.ts';

const accountId = '20000000-0000-7000-8000-000000000001';
const subjectId = '10000000-0000-7000-8000-000000000001';
const boardId = '30000000-0000-7000-8000-000000000001';
const threadId = '40000000-0000-7000-8000-000000000001';
const postId = '50000000-0000-7000-8000-000000000001';
const revisionId = '60000000-0000-7000-8000-000000000001';
const editionId = '70000000-0000-7000-8000-000000000001';
const offerId = '71000000-0000-7000-8000-000000000001';
const sha256 = 'b'.repeat(64);

const community: DevelopmentCommunityOutcome = {
  state: 'published',
  source: { provider: 'vndb', externalId: 'v2002', subjectId },
  board: { id: boardId, realmId: null, purpose: 'discussion', visibility: 'published', availability: 'available' },
  thread: { id: threadId, postId, revisionId, sha256 },
};

const sourceRead = {
  post: { id: postId, revisionId, authorId: accountId, availability: 'available', licence: 'CC-BY-4.0', sha256, subjectIds: [subjectId] },
  editionIdentity: { postId, revisionId, sha256, subjects: [{ id: subjectId, kind: 'available' }] },
};
const editionRead = {
  editionId,
  editionRevision: '2',
  state: 'published',
  targetSubjectId: subjectId,
  creatorAccountId: accountId,
  revisionId,
  sha256,
  licence: 'CC-BY-4.0',
};
const creatorEdition = {
  editionId,
  editionRevision: '2',
  state: 'published',
  creatorAccountId: accountId,
  targetSubjectId: subjectId,
  revisionId,
  sha256,
  licence: 'CC-BY-4.0',
};

test('edition create and separate publish resume the frozen source command and prove the creator readback', async () => {
  const intents: DevelopmentCommandIntent[] = [];
  const reads: string[] = [];
  let createAttempts = 0;
  const client: DevelopmentShowcaseClient = {
    async read(path) {
      reads.push(path);
      const value = path.includes('/revisions/') ? sourceRead : path === `/v1/contentEditions/${editionId}` ? editionRead : { editions: [creatorEdition], next: null };
      return { state: 'acknowledged', value };
    },
    async command<T>(intent, decode): Promise<DevelopmentSeedStep<T>> {
      intents.push(intent);
      if (intent.path === '/v1/contentEditions' && createAttempts++ === 0)
        return { state: 'unknown_delivery', operation: intent.path, code: 'transport-unknown' };
      const value = intent.path === '/v1/contentEditions'
        ? { editionId, editionRevision: '1' }
        : { editionId, editionRevision: '2' };
      return { state: 'acknowledged', value: decode(value) };
    },
  };
  const actor = { accountId, clientId: 'rezics-dev-showcase' };
  const first = await seedDevelopmentContentEdition({ community, actor, client });
  expect(first).toMatchObject({ state: 'unknown_delivery', operation: 'content_edition.create' });
  const resumed = await seedDevelopmentContentEdition({ community, actor, client });

  expect(resumed).toMatchObject({ state: 'published', editionId, editionRevision: '2', source: { postId, revisionId, targetSubjectId: subjectId, sha256, licence: 'CC-BY-4.0' } });
  expect(intents[0]).toEqual(intents[1]);
  expect(intents[0]).toMatchObject({
    actionKey: `local-content-edition-create:${postId}`,
    idempotencyKey: `local-content-edition-create:${postId}`,
    path: '/v1/contentEditions',
    body: { postId, revisionId, targetSubjectId: subjectId },
  });
  expect(intents[2]).toMatchObject({
    actionKey: `local-content-edition-publish:${editionId}`,
    idempotencyKey: `local-content-edition-publish:${editionId}`,
    path: `/v1/contentEditions/${editionId}:publish`,
    body: {},
    ifMatch: '"1"',
  });
  expect(reads).toContain(`/v1/accounts/${accountId}/editions?limit=20`);
});

test('a mismatched readback source refuses enrollment before an edition command', async () => {
  let commands = 0;
  const client: DevelopmentShowcaseClient = {
    read: async () => ({ state: 'acknowledged', value: { ...sourceRead, post: { ...sourceRead.post, authorId: subjectId } } }),
    command: async () => {
      commands++;
      return { state: 'unknown_delivery', operation: 'unexpected' };
    },
  };
  const result = await seedDevelopmentContentEdition({ community, actor: { accountId, clientId: 'rezics-dev-showcase' }, client });
  expect(result).toMatchObject({ state: 'refused', operation: 'post.revision.edition_identity', code: 'source-binding-mismatch' });
  expect(commands).toBe(0);
});

function capturedEdition() {
  return {
    benefit: {
      kind: 'content-edition',
      resourceType: 'content.edition',
      resource: { route: routeOf(editionId), id: editionId },
      version: { revisionId, sha256 },
      action: 'edition:read',
    },
    creatorAccountId: accountId,
    targetSubjectId: subjectId,
    source: { licence: 'CC-BY-4.0' },
    saleTermsReference: JSON.stringify([editionId, revisionId, sha256, '2']),
    delivery: 'fixed-content-edition',
    acquisition: 'one-time-account-bound',
    quantity: 1,
  };
}

test('Commerce uses the current supported money rule and reads back the exact creator offer binding', async () => {
  const intents: DevelopmentCommandIntent[] = [];
  const offer = {
    id: offerId,
    targetSubjectId: subjectId,
    title: 'Local showcase authored edition',
    currency: 'usd',
    unitAmountMinor: 50,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    state: 'active',
    contentEdition: capturedEdition(),
  };
  const createdOffer = {
    id: offerId,
    targetSubjectId: subjectId,
    title: 'Local showcase authored edition',
    currency: 'usd',
    unitAmountMinor: 50,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    state: 'active',
    contentEdition: capturedEdition(),
  };
  const client: DevelopmentShowcaseClient = {
    async read(path) {
      if (path === '/v1/commerceMoney')
        return {
          state: 'acknowledged',
          value: {
            factsVersion: 'stripe-money-v1',
            taxBehavior: 'exclusive',
            configuredSaleCurrencies: [
              { currency: 'usd', unit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' }, minAmountMinor: 50, maxAmountMinor: 99_999_999, chargeMultiple: 1 },
            ],
          },
        };
      return { state: 'acknowledged', value: { offers: [offer], next: null } };
    },
    async command<T>(intent, decode): Promise<DevelopmentSeedStep<T>> {
      intents.push(intent);
      return { state: 'acknowledged', value: decode({ offer: createdOffer }, intent.body) };
    },
  };
  const edition = {
    state: 'published' as const,
    editionId,
    editionRevision: '2',
    source: { postId, revisionId, targetSubjectId: subjectId, sha256, licence: 'CC-BY-4.0' as const },
  };
  const result = await seedDevelopmentContentEditionOffer({ edition, accountId, client });

  expect(result).toMatchObject({
    state: 'created',
    offerId,
    contentEditionId: editionId,
    editionRevision: '2',
    targetSubjectId: subjectId,
    currency: 'usd',
    unitAmountMinor: 50,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
  });
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    actionKey: `local-showcase-offer:${editionId}`,
    idempotencyKey: `local-showcase-offer:${editionId}`,
    path: '/v1/offers',
    body: { contentEditionId: editionId, title: 'Local showcase authored edition', currency: 'usd', unitAmountMinor: 50, taxCode: 'txcd_10302000' },
  });
  expect(intents[0]?.body).not.toHaveProperty('targetSubjectId');
});

test('unknown offer delivery remains distinct from a creator readback', async () => {
  const paths: string[] = [];
  const client: DevelopmentShowcaseClient = {
    read: async (path) => {
      paths.push(path);
      return { state: 'acknowledged', value: { factsVersion: 'stripe-money-v1', taxBehavior: 'exclusive', configuredSaleCurrencies: [{ currency: 'usd', unit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' }, minAmountMinor: 50, maxAmountMinor: 99_999_999, chargeMultiple: 1 }] } };
    },
    command: async () => ({ state: 'unknown_delivery', operation: '/v1/offers', code: 'transport-unknown' }),
  };
  const result = await seedDevelopmentContentEditionOffer({
    edition: { state: 'published', editionId, editionRevision: '2', source: { postId, revisionId, targetSubjectId: subjectId, sha256, licence: 'CC-BY-4.0' } },
    accountId,
    client,
  });
  expect(result).toMatchObject({ state: 'unknown_delivery', operation: 'offer.create' });
  expect(paths).toEqual(['/v1/commerceMoney']);
});
