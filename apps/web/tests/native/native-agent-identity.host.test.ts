import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import {
  createNativeAgentIdentityFixture,
  settledPage,
  submitAccountOperation,
  type NativeAgentIdentityFixture,
} from './native-agent-identity-fixture.ts';

setDefaultTimeout(660_000);

let fixture: NativeAgentIdentityFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
}, 60_000);

async function api(
  f: NativeAgentIdentityFixture,
  path: string,
  init: RequestInit = {},
  persona?: string,
): Promise<{ status: number; body: any }> {
  const response = await f.stack.kernel(path, init, persona);
  const body = await response.text();
  return { status: response.status, body: body ? JSON.parse(body) : null };
}

async function getIdentity(f: NativeAgentIdentityFixture, accountId: string) {
  const result = await api(f, `/v1/accounts?ids=${encodeURIComponent(accountId)}`);
  expect(result.status).toBe(200);
  expect(result.body.accounts).toHaveLength(1);
  return result.body.accounts[0] as Record<string, unknown>;
}

async function publicProfile(f: NativeAgentIdentityFixture, handle: string) {
  const result = await api(f, `/v1/accounts?handle=${encodeURIComponent(handle)}`);
  expect(result.status).toBe(200);
  expect(result.body.accounts).toHaveLength(1);
  return result.body.accounts[0] as Record<string, unknown>;
}

async function publicProfileWithSubject(f: NativeAgentIdentityFixture, handle: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await api(f, `/v1/accounts?handle=${encodeURIComponent(handle)}`);
    const profile = result.status === 200 ? result.body.accounts?.[0] : undefined;
    if (profile?.subject) return profile as Record<string, unknown>;
    await Bun.sleep(250);
  }
  throw new Error(`Native public identity did not publish its account subject for @${handle}`);
}

async function accountPage(f: NativeAgentIdentityFixture, persona: string | undefined, handle: string) {
  return api(
    f,
    '/v1/pages:read',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { account: handle }, languages: ['en'] }),
    },
    persona,
  );
}

async function subjectPage(f: NativeAgentIdentityFixture, subject: string) {
  return api(f, '/v1/pages:read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { subject }, languages: ['en'] }),
  });
}

async function createVerifiedSubject(
  f: NativeAgentIdentityFixture,
  accountId: string,
  type: 'schema:Person' | 'schema:Organization' | 'schema:SoftwareApplication',
  label: string,
  requester: string,
): Promise<string> {
  const created = await f.stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ type, labels: { en: label } }),
    },
    'alice',
  );
  expect(created.status).toBe(201);
  const subject = (await created.json()).subject as { id: string };

  const request = await f.stack.kernel(
    `/v1/accounts/${accountId}:requestVerification`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({
        subject: subject.id,
        statement: 'This catalogue identity belongs to this agent.',
        links: [],
      }),
    },
    requester,
  );
  expect(request.status).toBe(201);
  const requestId = (await request.json()).verificationRequest.id as string;

  const approval = await f.stack.kernel(
    `/v1/verification-requests/${requestId}:approve`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({}),
    },
    'governor',
  );
  expect(approval.status).toBe(200);

  let verified = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const read = await api(f, `/v1/accounts?agent=${encodeURIComponent(subject.id)}`);
    if (read.status === 200 && read.body.accounts?.[0]?.id === accountId && read.body.accounts[0].verified === true) {
      verified = true;
      break;
    }
    await Bun.sleep(250);
  }
  expect(verified).toBe(true);
  return subject.id;
}

async function checkIdentityPage(
  f: NativeAgentIdentityFixture,
  page: Page,
  locale: string,
  handle: string,
  headingName: string,
  schemaName: string,
  subjectLabel: string,
  expectedClaim: 'Person' | 'Organization' | 'SoftwareApplication',
  privateValue: string,
  operatorHandle?: string,
) {
  const response = await settledPage(page, `${f.stack.web}/${locale}/@${encodeURIComponent(handle)}`);
  expect(response?.status()).toBe(200);
  expect(await page.getByRole('heading', { level: 1, name: headingName, exact: true }).isVisible()).toBe(true);
  expect(await page.locator('meta[property="profile:username"]').getAttribute('content')).toBe(handle);
  const body = await page.locator('body').innerText();
  expect(body).toContain(subjectLabel);
  if (operatorHandle) expect(body).toContain(`@${operatorHandle}`);
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  expect(jsonLd).toBeTruthy();
  const graph = JSON.parse(jsonLd!) as { '@graph': { '@type': string; mainEntity?: Record<string, unknown> }[] };
  const profilePage = graph['@graph'].find((node) => node['@type'] === 'ProfilePage');
  expect(profilePage?.mainEntity).toMatchObject({
    '@type': expectedClaim,
    name: schemaName,
    alternateName: handle,
    url: expect.stringContaining(`/@${handle}`),
  });
  const html = await page.content();
  expect(html).not.toContain(privateValue);
  for (const privateField of ['email', 'credentials', 'passwordHash', 'sessions', 'consent', 'controllerId'])
    expect(html).not.toContain(`\"${privateField}\":`);
}

const nativeAccountPassword = 'semantic outcome registration password with enough entropy';

async function submitOrganizationWithFreshAuth(page: Page, accountId: string, email: string, path: string) {
  const approve = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/account-operations/approve' && response.request().method() === 'POST',
    );
  const first = approve();
  await page.getByRole('button', { name: 'Create organization', exact: true }).click();
  const firstResponse = await first;
  const firstBody = await firstResponse.json();
  const attempts = [{ status: firstResponse.status(), body: firstBody }];

  if (firstResponse.status() === 401 && firstBody.error === 'step_up_required') {
    await page.waitForURL((url) => url.pathname === '/step-up');
    expect(new URL(page.url()).searchParams.get('return_to')).toBe(path);
    expect(new URL(page.url()).searchParams.get('account_operation')).toBe('organization');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(nativeAccountPassword);
    const signIn = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/signin' && response.request().method() === 'POST',
    );
    await Promise.all([
      page.waitForURL((url) => url.pathname === path, { timeout: 120_000 }),
      page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
    ]);
    const signInResponse = await signIn;
    expect(signInResponse.status()).toBe(200);
    expect(signInResponse.request().postDataJSON()).toEqual({
      email,
      password: nativeAccountPassword,
      client_id: 'rezics-auth-account-operations',
      scope: ['organization:create'],
    });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    const sessionProof = await page.evaluate(async () => {
      const response = await fetch('/session', { credentials: 'same-origin', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    expect(sessionProof).toEqual({
      status: 200,
      body: {
        account_id: accountId,
        client_id: 'rezics-auth-account-operations',
        scope: ['organization:create'],
        authn_epoch: expect.any(Number),
        auth_time: expect.any(Number),
        amr: expect.any(Array),
      },
    });
    const retry = approve();
    await page.getByRole('button', { name: 'Create organization', exact: true }).click();
    const retryResponse = await retry;
    attempts.push({ status: retryResponse.status(), body: await retryResponse.json() });
  }

  return attempts;
}

test('native agent identity, publication, handle forwarding and account operations stay bound to one account', async () => {
  fixture = await createNativeAgentIdentityFixture();
  const f = fixture;

  const oldHandle = (await getIdentity(f, f.aliceId)).handle as string;
  const page = await f.stack.request(`${f.stack.web}/en/@${encodeURIComponent(oldHandle)}`);
  expect(page.status).toBe(200);

  const organizationHandle = `team-${crypto.randomUUID().slice(0, 8)}`;
  const organizationResponses: number[] = [];
  f.governor.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path === '/account-operations/approve' || path === '/account-operations/execute')
      organizationResponses.push(response.status());
  });
  // Bootstrap grants active accounts permission, and Auth must retain the operation
  // scope on the fresh token; the approval must stay attributed to its human.
  await settledPage(f.governor, `${f.stack.issuerOrigin}/organizations/new`);
  await f.governor.getByLabel('Handle', { exact: true }).fill(organizationHandle);
  const organizationApprovals = await submitOrganizationWithFreshAuth(
    f.governor,
    f.governorId,
    f.governorEmail,
    '/organizations/new',
  );
  expect(await f.stack.accountOperationActors()).toContainEqual({
    accountId: f.governorId,
    scopes: expect.arrayContaining(['organization:create']),
  });
  expect(organizationApprovals.at(-1)).toMatchObject({ status: 200, body: { reference: expect.any(String) } });
  await f.governor.getByRole('status').waitFor();
  expect(organizationResponses).toEqual([...organizationApprovals.map(({ status }) => status), 200]);
  const createdOrganization = await publicProfile(f, organizationHandle);
  expect(createdOrganization).toMatchObject({ kind: 'organization', handle: organizationHandle, state: 'active' });
  const organizationId = createdOrganization.id as string;

  const organizationFailureHandle = `bob-team-${crypto.randomUUID().slice(0, 8)}`;
  const bobOperationResponses: number[] = [];
  f.bob.on('response', (response) => {
    if (['/account-operations/approve', '/account-operations/execute'].includes(new URL(response.url()).pathname))
      bobOperationResponses.push(response.status());
  });
  await settledPage(f.bob, `${f.stack.issuerOrigin}/organizations/new`);
  await f.bob.getByLabel('Handle', { exact: true }).fill(organizationFailureHandle);
  const bobApprovals = await submitOrganizationWithFreshAuth(f.bob, f.bobId, f.bobEmail, '/organizations/new');
  expect(bobApprovals.at(-1)).toMatchObject({
    status: 403,
    body: { error: 'account_operation_denied', effect_status: 'not_applied' },
  });
  await f.bob.getByRole('alert').waitFor();
  expect(bobOperationResponses).toEqual(bobApprovals.map(({ status }) => status));
  expect((await api(f, `/v1/accounts?handle=${encodeURIComponent(organizationFailureHandle)}`)).body.accounts).toEqual(
    [],
  );

  const automatedHandle = `agent-${crypto.randomUUID().slice(0, 8)}`;
  const automated = await f.createAutomatedActor('alice', automatedHandle);

  const aliceSubject = await createVerifiedSubject(f, f.aliceId, 'schema:Person', 'Native Alice Identity', 'alice');
  const organizationSubject = await createVerifiedSubject(
    f,
    organizationId,
    'schema:Organization',
    'Native Organization Identity',
    'governor',
  );
  const automatedIdentity = await publicProfileWithSubject(f, automatedHandle);
  const automatedNativeSubject = automatedIdentity.subject as { id: string; label: string; type: string };
  expect(automatedNativeSubject.type).toBe('schema:SoftwareApplication');

  const identityCases = [
    {
      id: f.aliceId,
      handle: oldHandle,
      subjectId: aliceSubject,
      subjectLabel: 'Native Alice Identity',
      verified: true,
      claim: 'Person' as const,
      nativeType: 'schema:Person',
      automated: false,
      operatorId: null,
    },
    {
      id: organizationId,
      handle: organizationHandle,
      subjectId: organizationSubject,
      subjectLabel: 'Native Organization Identity',
      verified: true,
      claim: 'Organization' as const,
      nativeType: 'schema:Organization',
      automated: false,
      operatorId: null,
    },
    {
      id: automated.accountId,
      handle: automatedHandle,
      subjectId: automatedNativeSubject.id,
      subjectLabel: automatedNativeSubject.label,
      verified: false,
      claim: 'SoftwareApplication' as const,
      nativeType: automatedNativeSubject.type,
      automated: true,
      operatorId: f.aliceId,
    },
  ];
  const profileNames = new Map<string, { heading: string; schema: string }>();
  for (const item of identityCases) {
    const identity = await publicProfile(f, item.handle);
    expect(identity).toMatchObject({
      id: item.id,
      kind: item.id === organizationId ? 'organization' : 'actor',
      handle: item.handle,
      automated: item.automated,
      operatorId: item.operatorId,
      verified: item.verified,
      subject: { id: item.subjectId, label: item.subjectLabel, type: item.nativeType },
    });
    const read = await accountPage(f, undefined, item.handle);
    expect(read.status).toBe(200);
    expect(read.body.account).toBe(item.id);
    expect(read.body.template).toEqual({ scope: 'type', key: `schema:${item.claim}` });
    if (item.verified) {
      const bySubject = await subjectPage(f, item.subjectId);
      expect(bySubject.status).toBe(308);
      expect(bySubject.body).toEqual({ redirect: { from: item.subjectId, to: item.handle } });
    } else {
      // The native contract keeps an unverified automated account's synthetic subject private from account lookup.
      // Its subject URL remains a subject page and must not disclose the account association.
      const bySubject = await subjectPage(f, item.subjectId);
      expect(bySubject.status).toBe(200);
      expect(bySubject.body.subject).toBe(item.subjectId);
      expect(bySubject.body).not.toHaveProperty('account');
      expect(JSON.stringify(bySubject.body)).not.toContain(f.aliceEmail);
    }
    const privateBody = JSON.stringify(read.body);
    expect(privateBody).not.toContain(f.aliceEmail);
    for (const privateField of ['email', 'credentials', 'passwordHash', 'sessions', 'consent', 'controllerId'])
      expect(privateBody).not.toContain(`\"${privateField}\":`);
    const displayName = typeof identity.displayName === 'string' ? identity.displayName : '';
    profileNames.set(item.handle, {
      heading: displayName || `@${item.handle}`,
      schema: displayName || item.handle,
    });
  }
  for (const item of identityCases)
    await checkIdentityPage(
      f,
      f.anonymous,
      'en',
      item.handle,
      profileNames.get(item.handle)!.heading,
      profileNames.get(item.handle)!.schema,
      item.subjectLabel,
      item.claim,
      f.aliceEmail,
      item.automated ? oldHandle : undefined,
    );

  const automatedSubjectPage = await settledPage(
    f.anonymous,
    `${f.stack.web}/en/subjects/${encodeURIComponent(automatedNativeSubject.id)}`,
  );
  expect(automatedSubjectPage?.status()).toBe(200);
  expect(new URL(f.anonymous.url()).pathname.startsWith(`/en/subjects/${automatedNativeSubject.id}/`)).toBe(true);
  expect(await f.anonymous.locator('body').innerText()).toContain(automatedNativeSubject.label);
  expect(await f.anonymous.content()).not.toContain(f.aliceEmail);

  const publicCollection = await f.stack.kernel(
    '/v1/collections',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({
        title: 'Native public collection',
        description: 'Visible through the account page until its publication setting changes.',
        visibility: 'public',
      }),
    },
    'alice',
  );
  expect(publicCollection.status).toBe(201);
  const collectionId = (await publicCollection.json()).collection.id as string;

  await settledPage(f.alice, `${f.stack.web}/en/settings`);
  await f.alice.getByLabel('Display name', { exact: true }).fill('Alice Native');
  await f.alice.getByLabel('Biography', { exact: true }).fill('A public biography edited through Settings.');
  await f.alice.getByRole('button', { name: 'Save profile', exact: true }).click();
  await f.alice.locator('#profile').getByText('Profile saved.', { exact: true }).waitFor();
  await f.alice.locator('#public-activity').getByRole('switch', { name: 'Posts', exact: true }).click();
  await f.alice.locator('#public-activity').getByRole('switch', { name: 'Collections', exact: true }).click();
  await f.alice.locator('#public-activity').getByText('Saved', { exact: true }).waitFor();
  await f.alice.reload({ waitUntil: 'domcontentloaded' });
  await f.alice.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  expect(await f.alice.getByLabel('Display name', { exact: true }).inputValue()).toBe('Alice Native');
  expect(await f.alice.getByLabel('Biography', { exact: true }).inputValue()).toBe(
    'A public biography edited through Settings.',
  );
  expect(
    await f.alice
      .locator('#public-activity')
      .getByRole('switch', { name: 'Posts', exact: true })
      .getAttribute('aria-checked'),
  ).toBe('false');
  expect(
    await f.alice
      .locator('#public-activity')
      .getByRole('switch', { name: 'Collections', exact: true })
      .getAttribute('aria-checked'),
  ).toBe('false');

  const updated = await publicProfile(f, oldHandle);
  expect(updated).toMatchObject({
    displayName: 'Alice Native',
    bio: 'A public biography edited through Settings.',
  });
  expect(updated.publicViews).toMatchObject({ posts: false, collections: false });
  const alicePage = await accountPage(f, 'alice', oldHandle);
  const bobPage = await accountPage(f, 'bob', oldHandle);
  const anonymousPage = await accountPage(f, undefined, oldHandle);
  expect(JSON.stringify(alicePage.body.reads)).toContain(collectionId);
  expect(JSON.stringify(bobPage.body.reads)).not.toContain(collectionId);
  expect(JSON.stringify(anonymousPage.body.reads)).not.toContain(collectionId);
  expect(JSON.stringify(bobPage.body)).toContain('A public biography edited through Settings.');
  expect(JSON.stringify(anonymousPage.body)).toContain('A public biography edited through Settings.');
  for (const body of [alicePage.body, bobPage.body, anonymousPage.body])
    expect(JSON.stringify(body)).not.toContain(f.aliceEmail);

  const rename = await submitAccountOperation(f.alice, f.stack.issuerOrigin, {
    kind: 'rename',
    accountId: f.aliceId,
    handle: `alice-renamed-${crypto.randomUUID().slice(0, 6)}`,
    expectedHandle: oldHandle,
  });
  expect(rename.approval.status).toBe(200);
  expect(rename.execution?.status).toBe(200);
  const newHandle = (await getIdentity(f, f.aliceId)).handle as string;
  expect(newHandle).not.toBe(oldHandle);
  expect(await publicProfile(f, oldHandle)).toMatchObject({
    id: f.aliceId,
    handle: newHandle,
    movedTo: newHandle,
  });
  const staleRedirects: number[] = [];
  const captureStaleRedirect = (response: import('playwright').Response) => {
    if (response.request().isNavigationRequest() && new URL(response.url()).pathname.startsWith(`/ja/@${oldHandle}`))
      staleRedirects.push(response.status());
  };
  f.anonymous.on('response', captureStaleRedirect);
  const staleResponse = await settledPage(f.anonymous, `${f.stack.web}/ja/@${oldHandle}?receipt=identity`);
  const staleViewResponse = await settledPage(f.anonymous, `${f.stack.web}/ja/@${oldHandle}/details?receipt=identity`);
  f.anonymous.off('response', captureStaleRedirect);
  expect(staleRedirects).toEqual([308, 308]);
  expect(staleResponse?.status()).toBe(200);
  expect(new URL(f.anonymous.url()).pathname).toBe(`/ja/@${newHandle}`);
  expect(new URL(f.anonymous.url()).search).toBe('?receipt=identity');
  expect(staleViewResponse?.status()).toBe(200);
  expect(new URL(f.anonymous.url()).pathname).toBe(`/ja/@${newHandle}/details`);
  expect(new URL(f.anonymous.url()).search).toBe('?receipt=identity');
  await settledPage(f.anonymous, `${f.stack.web}/ja/@${newHandle}`);
  expect(await f.anonymous.locator('meta[property="profile:username"]').getAttribute('content')).toBe(newHandle);
  expect(await f.anonymous.locator('body').innerText()).toContain('Alice Native');
  const subjectPage = await settledPage(f.anonymous, `${f.stack.web}/ja/subjects/${aliceSubject}`);
  expect(subjectPage?.status()).toBe(200);
  expect(new URL(f.anonymous.url()).pathname).toBe(`/ja/@${newHandle}`);
  const organizationPage = await settledPage(f.anonymous, `${f.stack.web}/zh-Hans/subjects/${organizationSubject}`);
  expect(organizationPage?.status()).toBe(200);
  expect(new URL(f.anonymous.url()).pathname).toBe(`/zh-Hans/@${organizationHandle}`);
  await f.stack.flushObservations();

  const unrelated = new Set<string>();
  const growth = new Map<number, number>();
  for (const scale of [1, 8, 64]) {
    while (unrelated.size < scale) {
      const persona = `identity-growth-${unrelated.size}`;
      const created = await f.stack.authPersona(persona);
      unrelated.add(created.accountId);
    }
    const pageContext = await f.auth.context('anonymous');
    const visit = await pageContext.newPage();
    const before = f.stack.kernelRequests().length;
    const rendered = await settledPage(visit, `${f.stack.web}/en/@${newHandle}`);
    expect(rendered?.status()).toBe(200);
    await f.stack.flushObservations();
    const calls = f.stack
      .kernelRequests()
      .slice(before)
      .filter((request) => request.url.startsWith('/v1/')).length;
    growth.set(scale, calls);
    await visit.close();
  }
  expect(growth.get(1)).toBeGreaterThan(0);
  expect(growth.get(8)).toBe(growth.get(1));
  expect(growth.get(64)).toBe(growth.get(1));

  const badHandle = await settledPage(f.anonymous, `${f.stack.web}/en/@invalid%20handle`);
  expect(badHandle?.status()).toBe(404);
  const unavailableHandle = await settledPage(f.anonymous, `${f.stack.web}/en/@admin`);
  expect(unavailableHandle?.status()).toBe(404);

  const untouchedAlice = await getIdentity(f, f.aliceId);
  const forgedDeletion = await submitAccountOperation(f.bob, f.stack.issuerOrigin, {
    kind: 'delete',
    accountId: f.aliceId,
  });
  expect(forgedDeletion.approval.status).toBe(403);
  expect(forgedDeletion.execution).toBeUndefined();
  expect(await getIdentity(f, f.aliceId)).toEqual(untouchedAlice);

  const signup = await f.auth.signUp('newcomer');
  const newcomerPage = signup.context.pages()[0]!;
  await newcomerPage.goto(`${f.stack.issuerOrigin}/account/delete`, { waitUntil: 'domcontentloaded' });
  await newcomerPage.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  const newcomerSession = await newcomerPage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'same-origin', cache: 'no-store' });
    return response.json() as Promise<{ account_id: string }>;
  });
  const newcomerId = newcomerSession.account_id;
  const newcomerIdentity = await getIdentity(f, newcomerId);
  const deletedHandle = newcomerIdentity.handle as string;
  const deleteResponses: number[] = [];
  newcomerPage.on('response', (response) => {
    if (['/account-operations/approve', '/account-operations/execute'].includes(new URL(response.url()).pathname))
      deleteResponses.push(response.status());
  });
  const confirmation = newcomerPage.getByRole('textbox', {
    name: 'Type “delete my account” to confirm.',
    exact: true,
  });
  const deleteButton = newcomerPage.getByRole('button', { name: 'Delete account', exact: true });
  expect(await deleteButton.isDisabled()).toBe(true);
  await confirmation.fill('delete another account');
  expect(await deleteButton.isDisabled()).toBe(true);
  expect(deleteResponses).toEqual([]);
  await confirmation.fill('delete my account');
  await deleteButton.click();
  await newcomerPage.getByRole('status').waitFor({ timeout: 120_000 });
  expect(deleteResponses).toEqual([200, 200]);

  const tombstone = await getIdentity(f, newcomerId);
  expect(tombstone).toEqual({ id: newcomerId, state: 'deleted', kind: 'actor' });
  expect((await api(f, `/v1/accounts?handle=${encodeURIComponent(deletedHandle)}`)).body.accounts).toEqual([]);
  const deletedPage = await settledPage(f.anonymous, `${f.stack.web}/en/@${deletedHandle}`);
  expect(deletedPage?.status()).toBe(404);
  expect(await f.anonymous.locator('body').innerText()).not.toContain(deletedHandle);
});
