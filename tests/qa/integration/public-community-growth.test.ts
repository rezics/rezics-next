import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { discoveryGrowthMeter } from './support/discovery-growth.ts';
import { prepareSqlReadWork } from './support/sql-read-work.ts';

interface Page { items: { id?: string; reply?: string }[]; nextCursor: string | null; next?: string | null }

test('Realm feed, Best, Top, board and notification pages visit a bounded post neighbourhood', async () => {
  await prepareSqlReadWork();
  const meter = discoveryGrowthMeter();
  const home = await startHomeStack('public-community-growth', { projectionStart: 'current', profileCredits: true });
  let failures: string[] = [];
  try {
    const author = await home.provision('Community growth publisher', home.author.token);
    const recipient = await home.provision('Community growth reader', home.reader.token);
    const grant = async (scope: string, action: string) => grantFixtureAuthority(home.stack.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: home.author.principalId, actor: author, action, lifetime: '8 hours' }],
      grant: { actor: author, action, lifetime: '8 hours' },
    });
    const realm = await home.json<{ realm: string }>(await home.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Community growth', capabilities: ['realm'], actingSubject: author,
    }, home.author.token), 201);
    const root = `/v1/realms/${realm.realm.slice(-36)}`;
    await grant(`review:decide:${realm.realm}`, 'review.decide');
    await grant(`reply:place:${realm.realm}`, 'reply.place');
    await grant('classification:define:global', 'classification.proposition.define');
    const board = await home.json<{ concept: string }>(await home.call('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: 'Growth board' }], alternativeLabels: [], broader: [], narrower: [],
      actingSubject: author,
    }, home.author.token), 201);
    const work = await home.stack.publicWork(author, ['en'], 'Community growth source');
    await grant(`work:read:${work.work}`, 'work.read');
    const basis = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/works/${work.work.slice(-36)}?actingSubject=${encodeURIComponent(author)}`, undefined, home.author.token));
    const started = performance.now();
    let count = 0;
    for (const size of [10, 26, 74]) {
      for (; count < size; count++) {
        const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
        const draft = await home.json<{ revisionId: string; revisionDigest: string }>(await home.call('POST',
          '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1', reply, variantId,
            rootTarget: work.work, rootRevision: basis.revision, language: 'en', direction: 'ltr',
            expectedHead: null, body: `Growth discussion ${count}`, actingSubject: author }, home.author.token), 201);
        const identity = { reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest };
        await home.json(await home.call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
          reply, variantId, revisionId: draft.revisionId, author, rootTarget: work.work,
          rootRevision: basis.revision, parentReply: null, parentRevision: null, contextRevision: null }, home.author.token), 201);
        const review = await home.json<{ decisionId: string }>(await home.call('POST', '/v1/realm-reply-reviews', {
          profile: 'realm-reply-review-v1', realm: realm.realm, ...identity, expectedGeneration: '0', supersedes: null,
          outcome: 'approved', method: 'human', methodRevision: 'growth-v1',
          dependencyDigest: createHash('sha256').update(work.work).digest('hex'), reasonReference: null,
          actingSubject: author }, home.author.token), 201);
        await home.json(await home.call('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
          realm: realm.realm, ...identity, reviewDecisionId: review.decisionId, expectedHead: null,
          concepts: [board.concept], primaryConcept: board.concept, actingSubject: author }, home.author.token), 201);
        // The real notification owner creates its seek and disclosure rows.
        // No fixture writes a notification index or fabricates a response.
        const enqueued = await home.stack.composition.notificationStore.enqueue({ sourceOwner: 'graph',
          sourceEvent: `growth:${randomUUID()}`, purpose: 'social', topic: 'reply',
          subject: { owner: 'graph', ref: reply, revision: `urn:rezics:content:revision:${draft.revisionId}` },
          disclosureBasis: 'realm-reply-v1', recipients: [home.reader.principalId],
          display: { kind: 'reply', actorAgent: author, realm: realm.realm, groupKey: reply } });
        expect(enqueued).toHaveLength(1);
      }
      await home.project();
      expect(performance.now() - started, 'fixture preparation stays below ten minutes').toBeLessThan(600_000);
      const reads = [
        { read: 'realm-feed', path: '/v1/feed', query: { scope: 'all', sort: 'new', realms: realm.realm } },
        ...(['best', 'top'] as const).map(sort => ({ read: `rankings/${sort}`, path: `${root}/threads`, query: { sort, window: 'all' } })),
        ...(['new', 'best', 'top'] as const).map(sort => ({ read: `board/${sort}`, path: `${root}/threads`,
          query: { sort, window: 'all', concept: board.concept } })),
      ];
      for (const read of reads) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < 2; page++) {
          const query = new URLSearchParams({ ...read.query, limit: '2', ...(cursor ? { cursor } : {}) });
          const result = await meter.measure<Page>(home.stack, read.read, size, page,
            () => home.call('GET', `${read.path}?${query}`));
          expect(result.items).toHaveLength(2);
          for (const item of result.items) {
            const id = item.reply ?? item.id!;
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
          expect(result.nextCursor).toBeString();
          cursor = result.nextCursor;
        }
      }
      let before = 'latest';
      const seen = new Set<string>();
      for (let page = 0; page < 2; page++) {
        const result = await meter.measure<Page>(home.stack, 'notifications', size, page,
          () => home.call('GET', `/v1/me/notifications?${new URLSearchParams({ before, limit: '2' })}`,
            undefined, home.reader.token));
        expect(result.items).toHaveLength(2);
        for (const item of result.items) {
          expect(seen.has(item.id!)).toBe(false);
          seen.add(item.id!);
        }
        expect(result.next).toBeString();
        before = result.next!;
      }
      expect(recipient).toBeString();
    }
  } finally {
    failures = meter.finish('community');
    meter.restore();
    await home.stop();
  }
  expect(failures, failures.join('\n')).toEqual([]);
}, 480_000);
