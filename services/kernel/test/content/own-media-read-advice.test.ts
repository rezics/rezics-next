import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createKernelClient, type OwnMediaInventoryPage } from '@rezics/client';
import { mediaRealmDownloadFixture } from './media-realm-download-fixture.ts';

setDefaultTimeout(360_000);
let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;
beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
}, 240_000);
afterAll(async () => {
  await fixture?.close();
});

async function inventory() {
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${fixture.alice.bearer}` },
    fetch: (input, init) => fixture.kernel.handle(new Request(input, init)),
  });
  const result = await client.media.get();
  expect(result.status).toBe(200);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  const page: OwnMediaInventoryPage = result.data!;
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
