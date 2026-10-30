import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { failure, issuerPage, loadDetail, loadInventory, readCursors } from '../src/accounts/management/data';
import { inventoryExample, detailExample, organization } from '../src/accounts/management/story-api';
import { isSignedInPath } from '../src/session/guard';

// Focused transport tests. Native and real served journey review runs at integration, not in this fixture.
test('management adapters use generated native paths and the current caller credential without a target identity override', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        new URL(request.url).pathname.endsWith('/management') ? detailExample(organization.id) : inventoryExample(),
      );
    }) as typeof fetch,
  });
  const inventory = await loadInventory(client, 'Bearer current-viewer', {
    organizationsCursor: 'org-page',
    operatorsCursor: 'operator-page',
  });
  const detail = await loadDetail(client, 'Bearer current-viewer', organization.id, { membersCursor: 'member-page' });
  expect(inventory.state).toBe('ready');
  expect(detail.state).toBe('ready');
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/v1/me/managedAccounts',
    `/v1/accounts/${organization.id}/management`,
  ]);
  expect(new URL(requests[0]!.url).searchParams.get('organizationsCursor')).toBe('org-page');
  expect(new URL(requests[1]!.url).searchParams.get('membersCursor')).toBe('member-page');
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
    expect(new URL(request.url).searchParams.has('requested_by')).toBe(false);
  }
});

test('denial and unavailable reads never become an empty successful inventory', async () => {
  for (const [status, expected] of [
    [403, 'denied'],
    [503, 'unavailable'],
    [401, 'signed-out'],
    [404, 'missing'],
  ] as const) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async () => Response.json({ code: 'forbidden' }, { status })) as typeof fetch,
    });
    expect(await loadInventory(client, 'Bearer current-viewer', {})).toEqual({ state: expected });
  }
  expect(failure(503, { code: 'membership_inverse_incomplete' })).toEqual({ state: 'preparing' });
});

test('issuer links retain the two supported page profiles and account routes are private in every launch locale', () => {
  expect(issuerPage('https://auth.example.test', '/organizations/new')).toBe(
    'https://auth.example.test/organizations/new',
  );
  expect(issuerPage('https://auth.example.test', '/account/delete')).toBe('https://auth.example.test/account/delete');
  expect(issuerPage('javascript:alert(1)', '/account/delete')).toBeNull();
  expect(issuerPage('https://secret@auth.example.test', '/account/delete')).toBeNull();
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    expect(isSignedInPath(`/${locale}/accounts`)).toBe(true);
    expect(isSignedInPath(`/${locale}/accounts/${organization.id}`)).toBe(true);
    expect(isSignedInPath(`/${locale}/organizations/${organization.id}`)).toBe(true);
  }
  expect(readCursors({ operatorsCursor: 'next', membersCursor: 'x'.repeat(4097), requested_by: 'foreign' })).toEqual({
    operatorsCursor: 'next',
  });
});
