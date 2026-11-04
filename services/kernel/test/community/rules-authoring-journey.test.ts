import { afterAll, beforeAll, expect, test } from 'bun:test';
import { presentationSettingsFixture, type PresentationSettingsFixture } from './support/growth-realm-presentation-settings-fixture.ts';

let fixture: PresentationSettingsFixture;

beforeAll(async () => {
  fixture = await presentationSettingsFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
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
