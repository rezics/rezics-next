import { routeOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { assertGrowthAccessPaths, checkGrowth, seed } from '../support/growth.ts';
import {
  axes,
  presentationSettingsFixture,
  type PresentationSettingsFixture,
} from './support/growth-realm-presentation-settings-fixture.ts';
import { aggregateBanReviewPageCapture, banReviewPageWireCounts } from './support/ban-review-page-capture.ts';
import {
  assertSettingsSourcePrefixes,
  settingsPageGrowthFixture,
  type SettingsAxis,
} from './support/realm-settings-page-growth-fixture.ts';

let fixture: PresentationSettingsFixture;

beforeAll(async () => {
  fixture = await presentationSettingsFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

test.serial('Content publication and the Realm reference remain separate acknowledged effects', async () => {
  const realm = await fixture.select();
  const initial = await fixture.patch(realm, { presentation: realm.presentation });
  expect(initial.response.status, initial.text).toBe(200);
  const initialHead = initial.value.realm.headRevisionId as string;
  const key = crypto.randomUUID();
  const body = fromPlainText('New Realm rules\n\nUse the exact published revision.');
  const publication = await fixture.call('POST', '/v1/threads', {
    bearer: fixture.base.author.bearer,
    key,
    body: {
      boardId: realm.boardId,
      title: 'New Realm rules',
      body,
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [],
      visibility: 'published',
    },
  });
  expect(publication.response.status, publication.text).toBe(201);
  const post = publication.value.thread.firstPost;
  expect(post).toMatchObject({ availability: 'available', body, licence: 'LicenseRef-rezics-terms' });

  const publishedAgain = await fixture.call('POST', '/v1/threads', {
    bearer: fixture.base.author.bearer,
    key,
    body: {
      boardId: realm.boardId,
      title: 'New Realm rules',
      body,
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [],
      visibility: 'published',
    },
  });
  expect(publishedAgain.value.thread.id).toBe(publication.value.thread.id);
  expect(publishedAgain.value.thread.firstPost.revisionId).toBe(post.revisionId);

  const currentBeforeAttach = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`);
  expect(currentBeforeAttach.value.current.reference).toEqual(realm.pin);
  const concurrent = await fixture.patch(realm, { presentation: realm.presentation }, initialHead);
  expect(concurrent.response.status, concurrent.text).toBe(200);
  const concurrentHead = concurrent.value.realm.headRevisionId as string;
  const exact = { postId: post.id as string, revisionId: post.revisionId as string };
  const proposed = { ...realm.presentation, rules: exact };
  const conflict = await fixture.patch(realm, { presentation: proposed }, initialHead);
  expect(conflict.response.status).toBe(412);
  const retained = await fixture.call('GET', `/v1/posts/${exact.postId}/revisions/${exact.revisionId}`);
  expect(retained.response.status, retained.text).toBe(200);
  const stillCurrent = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`);
  expect(stillCurrent.value.current.reference).toEqual(realm.pin);

  const attachKey = crypto.randomUUID();
  const attached = await fixture.patch(realm, { presentation: proposed }, concurrentHead, attachKey);
  expect(attached.response.status, attached.text).toBe(200);
  const replay = await fixture.patch(realm, { presentation: proposed }, concurrentHead, attachKey);
  expect(replay.response.status, replay.text).toBe(200);
  expect(replay.value.realm.headRevisionId).toBe(attached.value.realm.headRevisionId);
  const readback = await fixture.call('GET', `/v1/realms/${realm.realmId}/settings`);
  expect(readback.value.snapshot.presentation.rules).toEqual(exact);
  expect(readback.value.snapshot.rules.value.body).toEqual(body);

  const editedBody = fromPlainText('New Realm rules\n\nA later exact revision.');
  const edited = await fixture.call('POST', `/v1/posts/${exact.postId}/revisions`, {
    key: crypto.randomUUID(),
    body: { body: editedBody },
    headers: { 'if-match': JSON.stringify(exact.revisionId) },
  });
  expect(edited.response.status, edited.text).toBe(200);
  const stillPinned = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`);
  expect(stillPinned.value.current.reference).toEqual(exact);
  expect(stillPinned.value.current.currentRevision).toBe(false);
  expect(stillPinned.value.actions.edit.state).toBe('stale');
  const nextExact = { postId: exact.postId, revisionId: edited.value.post.revisionId as string };
  const latestRealmHead = attached.value.realm.headRevisionId as string;
  const adopted = await fixture.patch(
    realm,
    { presentation: { ...realm.presentation, rules: nextExact } },
    latestRealmHead,
    crypto.randomUUID(),
  );
  expect(adopted.response.status, adopted.text).toBe(200);
  const finalReadback = await fixture.call('GET', `/v1/realms/${realm.realmId}/settings`);
  expect(finalReadback.value.snapshot.presentation.rules).toEqual(nextExact);
  expect(finalReadback.value.snapshot.rules.value.body).toEqual(editedBody);
});

test.serial('Realm rules authoring prepares the exact current policy and permitted native destinations', async () => {
  const realm = await fixture.select();
  const changed = await fixture.patch(realm, { presentation: realm.presentation });
  expect(changed.response.status, changed.text).toBe(200);

  const result = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`);
  expect(result.response.status, result.text).toBe(200);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  expect(result.value).toMatchObject({
    realm: { realmId: realm.realmId, head: changed.value.realm.headRevisionId },
    current: { state: 'available', reference: realm.pin },
    destinations: {
      state: 'available',
      items: expect.arrayContaining([expect.objectContaining({ boardId: realm.boardId })]),
    },
    actions: { attach: { state: 'allowed' }, create: { state: 'allowed' } },
  });

  const unrelated = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`, {
    bearer: fixture.base.other.bearer,
  });
  expect(unrelated.response.status).toBe(404);
  expect(unrelated.text).not.toContain(realm.head);
});

test.serial('Realm management does not grant Content publication or follow a hidden authoring route', async () => {
  const realm = await fixture.select();
  const attached = await fixture.patch(realm, { presentation: realm.presentation });
  expect(attached.response.status, attached.text).toBe(200);
  const manager = fixture.base.other;
  await fixture.manage(realm, manager);

  const managed = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`, {
    bearer: manager.bearer,
  });
  expect(managed.response.status, managed.text).toBe(200);
  expect(managed.value.actions.attach.state).toBe('allowed');
  expect(managed.value.actions.create.state).toBe('denied');
  expect(managed.value.destinations.items).toEqual([
    expect.objectContaining({ boardId: realm.boardId, create: { state: 'denied' } }),
  ]);

  const publicationKey = crypto.randomUUID();
  const newBody = fromPlainText('Rules prepared before manager revocation.');
  const publication = await fixture.call('POST', '/v1/threads', {
    key: publicationKey,
    body: {
      boardId: realm.boardId,
      title: 'Rules prepared before manager revocation',
      body: newBody,
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [],
      visibility: 'published',
    },
  });
  expect(publication.response.status, publication.text).toBe(201);
  const proposed = {
    ...realm.presentation,
    rules: { postId: publication.value.thread.firstPost.id, revisionId: publication.value.thread.firstPost.revisionId },
  };
  await fixture.manage(realm, manager, true);
  const revokedAttach = await fixture.patch(
    realm,
    { presentation: proposed },
    attached.value.realm.headRevisionId,
    crypto.randomUUID(),
    manager,
  );
  expect(revokedAttach.response.status).toBe(403);
  const unchanged = await fixture.call('GET', `/v1/realms/${realm.realmId}/settings`);
  expect(unchanged.value.snapshot.presentation.rules).toEqual(realm.pin);
  const discoverable = await fixture.call(
    'GET',
    `/v1/posts/${publication.value.thread.firstPost.id}/revisions/${publication.value.thread.firstPost.revisionId}`,
  );
  expect(discoverable.response.status, discoverable.text).toBe(200);
  expect(discoverable.value.post.body).toEqual(newBody);

  const publicationGrant = await fixture.call('POST', '/v1/grants', {
    body: {
      resource: { route: routeOf(realm.boardId), id: realm.boardId },
      subject: { kind: 'account', id: manager.accountId },
      actions: ['thread:create'],
      valid: '(,)',
    },
  });
  expect(publicationGrant.response.status, publicationGrant.text).toBe(201);
  const nonManager = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`, {
    bearer: manager.bearer,
  });
  expect(nonManager.response.status).toBe(404);
  expect(nonManager.text).not.toContain(realm.pin.postId);
  expect(nonManager.text).not.toContain(realm.pin.revisionId);
});

test.serial(
  'Rules preparation holds page, exact-source and response bounds as independent populations grow',
  async () => {
    const realm = await fixture.select();
    const attached = await fixture.patch(realm, { presentation: realm.presentation });
    expect(attached.response.status, attached.text).toBe(200);

    for (const axis of axes) {
      const report = await fixture.measure(`authoring-preparation`, realm, axis, async () => {
        const result = await fixture.call('GET', `/v1/realms/${realm.realmId}/rulesAuthoring`);
        expect(result.response.status, result.text).toBe(200);
        expect(result.value.current.reference).toEqual(realm.pin);
        expect(result.value.destinations.items.length).toBeLessThanOrEqual(20);
        expect(Buffer.byteLength(serializeDocument(result.value.current.body))).toBe(65_536);
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
      for (const sample of report.samples)
        for (const cost of sample.repetitions) {
          expect(cost.relations['content.revision']?.rows ?? 0).toBeLessThanOrEqual(6);
          expect(cost.relations['content.post']?.rows ?? 0).toBeLessThanOrEqual(66);
        }
    }
  },
);

const authoringGrowthAxes: readonly SettingsAxis[] = [
  'unrelated-realms',
  'realm-revisions',
  'rules-revisions',
  'selected-media-history',
  'authority-history',
];

test.serial(
  'Rules authoring composes fixed native work under independent Content, media, reference and authority growth',
  async () => {
    const growth = await settingsPageGrowthFixture();
    try {
      for (const axis of authoringGrowthAxes) {
        const realm = await growth.select({ images: true });
        const attached = await growth.patch(realm, { presentation: realm.presentation });
        expect(attached.response.status, attached.text).toBe(200);
        const population = await growth.population(realm, axis);
        const report = await checkGrowth(growth.db, {
          name: `Realm rules authoring ${axis}`,
          scales: [256, 1024, 4096],
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
          includeBackends: true,
          aggregateCaptures(primary, value) {
            if (axis === 'selected-media-history' || axis === 'authority-history') {
              assertSettingsSourcePrefixes(primary, 'unrelated-realms');
              assertSettingsSourcePrefixes(primary, 'rules-revisions');
            } else assertSettingsSourcePrefixes(primary, axis);
            return aggregateBanReviewPageCapture(primary, value);
          },
          counted: {
            bounds: {
              applicationRequestBytes: 'constant',
              applicationResponseBytes: 'constant',
              jwksRequestBytes: 'constant',
              jwksResponseBytes: 'constant',
            },
            read: banReviewPageWireCounts,
          },
          async grow(db, scale, previous) {
            await seed(db, population, { from: previous, to: scale });
            if (axis === 'selected-media-history' || axis === 'authority-history')
              expect(await growth.historyCount(realm, axis)).toBe(scale);
          },
          async operation() {
            const before = await growth.snapshot(realm);
            const result = await growth.readAuthoring(realm);
            expect(await growth.snapshot(realm)).toEqual(before);
            return result;
          },
        });
        const relations =
          axis === 'unrelated-realms'
            ? ['community.realm']
            : axis === 'realm-revisions'
              ? ['community.realm_revision']
              : axis === 'rules-revisions'
                ? ['content.revision']
                : axis === 'selected-media-history'
                  ? ['content.media', 'content.media_variant']
                  : ['access.resource_grant'];
        assertGrowthAccessPaths(`Realm rules authoring ${axis}`, report.samples, relations);
      }
    } finally {
      await growth.close();
    }
  },
  600_000,
);
