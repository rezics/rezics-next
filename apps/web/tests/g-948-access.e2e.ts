import { expect, test, type Page } from '@playwright/test';
import { accessActor, requestFixture, requestsInitial, ownRequestFixture } from '../features/manage/settings-fixtures.ts';
import { accessMessages } from '../features/manage/settings-messages.ts';

// Manager-owned browser verification against its shared Storybook. The router
// mounts the outsider component independently. These journeys exercise the real
// typed BFF client with served-contract responses; backend acceptance is separate.
const storybook = process.env.REZICS_STORYBOOK_URL ?? 'http://127.0.0.1:6006';
async function openStory(page: Page, title: string, name: string) {
  const response = await page.request.get(`${storybook}/index.json`);
  expect(response.ok()).toBe(true);
  const index = await response.json() as { entries: Record<string, { id: string; title: string; name: string; type: string }> };
  const entry = Object.values(index.entries).find(item => item.type === 'story' && item.title === title && item.name === name);
  expect(entry, `${title}/${name} must be indexed`).toBeDefined();
  await page.goto(`${storybook}/iframe.html?id=${entry!.id}&viewMode=story`);
}
const receipt = (state: 'accepted' | 'declined' | 'withdrawn', generation = '13') => ({
  receiptId: '00000000-0000-4000-8000-000000000041', requestId: requestFixture.id, requestGeneration: '1',
  generation, state, membershipId: null, membershipGeneration: null, replayed: false,
});

test('G-948: request, reload authoritative pending status, withdraw, and reload the withdrawal', async ({ page }) => {
  const commands: { path: string; body: unknown; key: string | undefined }[] = [];
  let ownState: 'pending' | 'withdrawn' | null = null;
  let ownReads = 0;
  await page.route('**/api/main/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/mine')) {
      ownReads++; return route.fulfill({ json: ownState ? ownRequestFixture(ownState) : { items: [], nextCursor: null, complete: true } });
    }
    if (path.endsWith('/basis')) return route.fulfill({ json: {
      policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '4', state: 'absent',
    } });
    commands.push({ path, body: request.postDataJSON() as unknown, key: request.headers()['idempotency-key'] });
    ownState = path.endsWith('/withdraw') ? 'withdrawn' : 'pending';
    return route.fulfill({ json: path.endsWith('/withdraw') ? receipt('withdrawn', '12')
      : { requestId: requestFixture.id, requestGeneration: '0', state: 'pending', replayed: false } });
  });
  await openStory(page, 'Space access/Join', 'Browser request');
  await page.getByRole('textbox').fill('I accept the community rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  expect(commands[0]!.body).toEqual({ actingSubject: accessActor, expectedMembershipGeneration: '4',
    expectedPolicyRevision: '12', termsRevision: 'rules-3', reason: 'I accept the community rules.' });
  expect(commands[0]!.key).toBeTruthy();
  await page.reload();
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  expect(ownReads).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Withdraw request', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Plans changed.');
  await dialog.getByRole('button', { name: 'Withdraw request', exact: true }).click();
  await expect(page.getByText(accessMessages.en.withdrawn, { exact: true })).toBeVisible();
  expect(commands[1]!.body).toEqual({ actingSubject: accessActor, expectedRequestGeneration: '0', reason: 'Plans changed.' });
  expect(commands[1]!.path).toContain(`/join-requests/${requestFixture.id}/withdraw`);
  await page.reload();
  await expect(page.getByText(accessMessages.en.withdrawn, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request to join', exact: true })).toBeVisible();
});

test('G-948: a lost request response survives reload and retries its exact command and key', async ({ page }) => {
  const commands: { body: unknown; key: string | undefined }[] = [];
  let basisReads = 0;
  await page.route('**/api/main/v1/**', async route => {
    const request = route.request();
    if (new URL(request.url()).pathname.endsWith('/mine')) return route.fulfill({ json: commands.length > 1
      ? ownRequestFixture('pending') : { items: [], nextCursor: null, complete: true } });
    if (new URL(request.url()).pathname.endsWith('/basis')) {
      basisReads++;
      return route.fulfill({ json: { policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '4', state: 'absent' } });
    }
    commands.push({ body: request.postDataJSON() as unknown, key: request.headers()['idempotency-key'] });
    if (commands.length === 1) return route.abort('failed');
    return route.fulfill({ json: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending', replayed: true } });
  });
  await openStory(page, 'Space access/Join', 'Browser request');
  await page.getByRole('textbox').fill('I accept the rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(accessMessages.en.failed);
  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('I accept the rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(basisReads).toBe(1);
});

for (const decision of ['accepted', 'declined'] as const) {
  test(`G-948: ${decision} refreshes a stale management generation before a reviewed retry`, async ({ page }) => {
    const commands: { body: unknown; key: string | undefined }[] = [];
    await page.route('**/api/main/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.includes('/agents/')) return route.fulfill({ json: { displayName: 'Lin Mei', handle: 'lin_mei' } });
      if (request.method() === 'GET') return route.fulfill({ json: { ...requestsInitial, generation: '13', nextCursor: null, complete: true } });
      commands.push({ body: request.postDataJSON() as unknown, key: request.headers()['idempotency-key'] });
      if (commands.length === 1) return route.fulfill({ status: 409, json: { code: 'stale_realm_management_basis' } });
      return route.fulfill({ json: receipt(decision, '14') });
    });
    await openStory(page, 'Manage/Join requests', 'Browser inbox');
    const label = decision === 'accepted' ? 'Approve' : 'Decline';
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('Reviewed against the rules.');
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(accessMessages.en.staleRequest);
    await expect(dialog.getByRole('button', { name: label, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Refresh requests' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Reason' })).toHaveValue('Reviewed against the rules.');
    await expect(dialog.getByRole('button', { name: label, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByText(decision === 'accepted' ? accessMessages.en.approved : accessMessages.en.decisionDeclined, { exact: true })).toBeVisible();
    expect(commands[0]!.body).toMatchObject({ decision, expectedGeneration: '12', expectedRequestGeneration: '0' });
    expect(commands[1]!.body).toMatchObject({ decision, expectedGeneration: '13', expectedRequestGeneration: '0' });
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(commands[1]!.body).not.toHaveProperty('consent');
  });
}

test('G-948: request managers can see the inbox without the settings link', async ({ page }) => {
  const authorityReads: string[] = [];
  await page.route('**/api/main/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    authorityReads.push(path);
    if (path.endsWith('/settings')) return route.fulfill({ status: 403, json: { code: 'realm_management_denied' } });
    return route.fulfill({ json: { space: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001' } });
  });
  await openStory(page, 'Manage/Join requests', 'Browser request-only manager');
  await expect.poll(() => authorityReads.filter(path => path.endsWith('/settings')).length).toBe(2);
  await expect(page.getByRole('link', { name: 'Join requests' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings & rules' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeEnabled();
});

test('G-948: changed admission terms require a rules reload and preserve the requester’s reason', async ({ page }) => {
  const commands: { body: unknown; key: string | undefined }[] = [];
  let basisReads = 0;
  await page.route('**/api/main/v1/**', async route => {
    const request = route.request();
    if (new URL(request.url()).pathname.endsWith('/mine')) return route.fulfill({ json: commands.length > 1
      ? ownRequestFixture('pending') : { items: [], nextCursor: null, complete: true } });
    if (new URL(request.url()).pathname.endsWith('/basis')) return route.fulfill({ json: {
      policyRevision: basisReads++ === 0 ? '12' : '13', termsRevision: basisReads === 1 ? 'rules-3' : 'rules-4',
      membershipGeneration: '4', state: 'absent',
    } });
    commands.push({ body: request.postDataJSON() as unknown, key: request.headers()['idempotency-key'] });
    return commands.length === 1 ? route.fulfill({ status: 409, json: { code: 'stale_realm_management_basis' } })
      : route.fulfill({ json: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending', replayed: false } });
  });
  await openStory(page, 'Space access/Join', 'Browser request');
  await page.getByRole('textbox').fill('I accept these community rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(accessMessages.en.joinChanged);
  await expect(page.getByRole('button', { name: 'Request to join', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload community rules' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('I accept these community rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  expect(commands[0]!.body).toMatchObject({ expectedPolicyRevision: '12', termsRevision: 'rules-3' });
  expect(commands[1]!.body).toMatchObject({ expectedPolicyRevision: '13', termsRevision: 'rules-4' });
  expect(commands[1]!.key).not.toBe(commands[0]!.key);
});


test('G-948: requester reload discovers a remote decline and offers a new request', async ({ page }) => {
  let state: 'pending' | 'declined' = 'pending';
  await page.route('**/api/main/v1/**', async route => {
    expect(new URL(route.request().url()).pathname).toContain('/join-requests/mine');
    return route.fulfill({ json: ownRequestFixture(state) });
  });
  await openStory(page, 'Space access/Join', 'Browser request');
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  state = 'declined';
  await page.reload();
  await expect(page.getByText(accessMessages.en.declined, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw request', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toBeVisible();
});

test('G-948: server search traverses matches beyond the loaded inbox and retains its query', async ({ page }) => {
  const reads: { q: string | null; cursor: string | null }[] = [];
  await page.route('**/api/main/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/agents/')) return route.fulfill({ json: { displayName: '遠方の読者', handle: 'distant_reader' } });
    reads.push({ q: url.searchParams.get('q'), cursor: url.searchParams.get('cursor') });
    expect(url.searchParams.get('q')).toBe('遠方');
    return route.fulfill({ json: url.searchParams.has('cursor') ? {
      generation: '12', items: [{ ...requestFixture, id: '00000000-0000-4000-8000-000000000023', reason: 'Second matching page.' }],
      nextCursor: null, complete: true,
    } : { generation: '12', items: [{ ...requestFixture, id: '00000000-0000-4000-8000-000000000022', reason: 'Match outside the initial inbox.' }],
      nextCursor: 'query-bound-cursor', complete: false } });
  });
  await openStory(page, 'Manage/Join requests', 'Browser inbox');
  await page.getByRole('searchbox').fill('遠方');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Match outside the initial inbox.')).toBeVisible();
  await expect(page.getByText(requestFixture.reason)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByText('Second matching page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  expect(reads).toEqual([{ q: '遠方', cursor: null }, { q: '遠方', cursor: 'query-bound-cursor' }]);
});

test('G-948: a committed request with a lost response is recovered by mine without resubmission', async ({ page }) => {
  let submitted = false;
  let commands = 0;
  await page.route('**/api/main/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/mine')) return route.fulfill({ json: submitted ? ownRequestFixture('pending')
      : { items: [], nextCursor: null, complete: true } });
    if (path.endsWith('/basis')) return route.fulfill({ json: {
      policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '4', state: 'absent',
    } });
    commands++; submitted = true;
    return route.abort('failed');
  });
  await openStory(page, 'Space access/Join', 'Browser request');
  await page.getByRole('textbox').fill('I accept the community rules.');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(accessMessages.en.failed);
  await page.reload();
  await expect(page.getByText(accessMessages.en.pending, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request to join', exact: true })).toHaveCount(0);
  expect(commands).toBe(1);
});
