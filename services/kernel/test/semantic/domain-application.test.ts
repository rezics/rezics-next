import { expect, test } from 'bun:test';
import { createSemanticDomain } from '../../src/semantic/application/index.ts';
import type { SemanticDomainPorts } from '../../src/semantic/contract/domain-ports.ts';
import type { IdentityJobRef, IdentityStepProgress } from '../../src/semantic/contract/identity-values.ts';
import { classifyIdentityRatingReviewEvidence } from '../../src/semantic/identity-core/index.ts';

const job: IdentityJobRef = { jobId: '018f0000-0000-7000-8000-000000000001', epoch: 7n };

function progress(): IdentityStepProgress {
  return {
    job,
    frontier: { after: ['key'], segment: 1 },
    state: 'more',
    work: { rows: 1, points: 0, statements: 2, bytes: 64, engineRequests: 0 },
    receipt: {
      job,
      step: 'search-canonical-index',
      version: 1,
      native: { partition: 3, epoch: 7, position: 12n, transactionId: 'tx-1' },
    },
  };
}

test('fake-port Semantic domain projects items, writes facts and dispatches identity without native modules', async () => {
  const calls: string[] = [];
  const ports: SemanticDomainPorts<{ id: string }, { id: string }> = {
    version: 1,
    identityEpoch: {
      version: 1,
      'search-canonical-index': async () => {
        calls.push('search');
        return progress();
      },
      'library-private-follow-counts': async () => {
        calls.push('library');
        return progress();
      },
    },
    libraryCustody: {
      stepIdentityEpoch: async () => {
        calls.push('custody');
        return progress();
      },
      readSourcePage: async () => {
        calls.push('page');
        return progress();
      },
    },
    searchCurrentness: {
      stepCanonicalIndex: async () => {
        calls.push('currentness');
        return progress();
      },
    },
    ratingReview: {
      subjectChanged: () => new Error('subject_changed'),
      identityEpochChanged: () => new Error('identity_epoch_changed'),
      pending: () => new Error('pending'),
      moved: (home) => new Error(`moved:${home}`),
      absent: () => new Error('absent'),
      undisclosed: () => new Error('undisclosed'),
      unavailable: () => new Error('unavailable'),
      foreignControl: () => new Error('foreign-control'),
    },
    contentLifecycle: {
      checkCover: async () => ({
        id: 'cover',
        digest: 'd',
        containerId: 'c',
        source: { source: 'vndb', external_id: 'v1', field_group: 'cover' as const },
      }),
      checkCovers: async () =>
        new Map([
          [
            'cover',
            {
              id: 'cover',
              digest: 'd',
              containerId: 'c',
              source: { source: 'vndb', external_id: 'v1', field_group: 'cover' as const },
            },
          ],
        ]),
      importedTupleRoute: () => 4,
    },
    hashing: { sha256Hex: (value) => `h:${value.length}` },
    routing: {
      routeOf: () => 1,
      derivedId: (_namespace, name, route) => `${route}:${name.length}`,
      partitionOf: (route) => Math.floor(route / 16),
    },
    facts: {
      writeFacts: async () => {
        calls.push('write');
      },
      initializeIdentity: async () => {
        calls.push('identity');
      },
    },
  };
  const domain = createSemanticDomain(ports);
  expect(Object.isFrozen(domain)).toBe(true);
  expect(domain.items.statementSlotId('subject', 'schema:url')).toBe('1:28');
  const cover = await domain.ports.contentLifecycle.checkCover({ query: async () => ({ rows: [] }) }, 'media');
  expect(cover?.digest).toBe('d');
  expect(
    (await domain.ports.contentLifecycle.checkCovers({ query: async () => ({ rows: [] }) }, ['cover'])).get('cover')
      ?.source.field_group,
  ).toBe('cover');
  expect(() => domain.ratingReview.throwFor({ state: 'pending', jobId: 'j', epoch: '1' })).toThrow('pending');
  await domain.subjects.writePlannedFacts(
    {
      tx: { id: 'tx' },
      route: 1,
      subjectId: 'subject',
      item: { type: 'schema:Person', labels: { en: 'A' } },
      type: 'schema:Person',
      release: {} as never,
      releaseDigest: 'r',
      transactionId: 't',
    },
    { subjectId: 'subject', type: 'schema:Person', facts: [], dataTypes: {}, relationProperties: [] },
  );
  await domain.subjects.initializeIdentity({ id: 'tx' }, 'original');
  const dispatched = domain.identity.dispatch('search-canonical-index', async () => progress());
  if ('kind' in dispatched) throw new Error('expected producer');
  await dispatched.run({ id: 'pool' }, job);
  expect(calls).toEqual(['write', 'identity', 'search']);
  expect(
    classifyIdentityRatingReviewEvidence(
      'a',
      'a',
      ['a'],
      [1],
      {
        mapping: { sourceOwners: [], sourceRows: [], controlOwners: [], pendingRows: [], currentRows: [] },
        subjects: [],
        controlLocators: [],
      },
      [{ original: 'a', sourceHome: 1 }],
    ).state,
  ).toBe('absent');
});
