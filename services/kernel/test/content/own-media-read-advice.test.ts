import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { OwnMediaInventoryPage } from '../../src/content/schemas.ts';
import { mediaRealmDownloadFixture } from './media-realm-download-fixture.ts';
import objects from '../../src/content/own-media-objects.sql';
import { observeSql } from './support/sql-observer.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

setDefaultTimeout(360_000);
let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;
beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
}, 240_000);
afterAll(async () => {
  await fixture?.close();
});

async function inventory() {
  const result = await fixture.call('GET', '/v1/media', { bearer: fixture.alice.bearer });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  const page = result.value as OwnMediaInventoryPage;
  return page.entries.find(({ id }) => id === fixture.privateImage.id)!;
}

test('retained uploader ownership does not advertise download after Realm read revocation', async () => {
  const before = await inventory();
  expect(before.actions.read?.variants).toContain('original');
  await fixture.revoke(fixture.protectedRealm.realmId, fixture.alice.accountId, ['realm:read']);
  try {
    const retained = await inventory();
    expect(retained.id).toBe(before.id);
    expect(retained.state).toBe('available');
    expect(retained.actions.read).toBeNull();
    expect(retained.actions.remove).toEqual({ operationId: 'media.erase' });
    expect(JSON.stringify(retained)).not.toMatch(/"(?:key|url|provenance|reservationRequestId)"\s*:/);
    expect((await fixture.download(before.id, 'original', fixture.alice.bearer)).response.status).toBe(404);
  } finally {
    await fixture.grant(fixture.alice.accountId, fixture.protectedRealm.realmId, ['realm:read']);
  }
  expect((await inventory()).actions.read?.variants).toContain('original');
});

test('Realm revocation between advice rounds fails without consuming the inventory frontier', async () => {
  const observer = observeSql(fixture.db.pool);
  const homes = new Set(
    [fixture.privateImage.id, fixture.publicRealmImage.id].map((id) => partitionOf(routeOf(id)!)),
  );
  const finalObjects = observer.hold({ statement: objects.sql, occurrence: homes.size + 1 }, 'after');
  const pending = fixture.call('GET', '/v1/media', { bearer: fixture.alice.bearer });
  try {
    await finalObjects.entered;
    await fixture.revoke(fixture.protectedRealm.realmId, fixture.alice.accountId, ['realm:read']);
    finalObjects.release();
    const failed = await pending;
    expect(failed.response.status).toBe(503);
    expect(failed.value.code).toBe('dependency_unavailable');
    // Retry the identical first-page input after the concurrent change settles.
    expect((await inventory()).actions.read).toBeNull();
  } finally {
    finalObjects.release();
    await pending;
    await observer.close();
    await fixture.grant(fixture.alice.accountId, fixture.protectedRealm.realmId, ['realm:read']);
  }
});
