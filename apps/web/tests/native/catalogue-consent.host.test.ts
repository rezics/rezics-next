import { afterAll, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect } from 'playwright/test';
import {
  startCatalogueConsentFixture,
  type CatalogueConsentAddress,
  type CatalogueConsentFixture,
} from './catalogue-consent-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(660_000);

const lifecycle = new NativeTestLifecycle('catalogue consent suite');
let fixture: CatalogueConsentFixture | undefined;

nativeBeforeAll(lifecycle, 900_000, async () => {
  fixture = await startCatalogueConsentFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function openConsent(page: Page, address: CatalogueConsentAddress): Promise<void> {
  await page.goto(new URL(address.href, fixture!.stack.web).href, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  await expect(page.getByRole('heading', { name: 'Statement consent', exact: true })).toBeVisible();
}

async function serverAction(page: Page, click: () => Promise<unknown>): Promise<void> {
  const response = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname.includes('_serverFn'),
    ),
    click(),
  ]).then(([result]) => result);
  expect(response.status()).toBeLessThan(400);
}

async function kernelNow(): Promise<NativeKernelRequest[]> {
  await fixture!.stack.syncKernelRequests();
  return fixture!.stack.kernelRequests().filter((request) => !request.fixtureRequest);
}

function posts(requests: readonly NativeKernelRequest[], path: string): NativeKernelRequest[] {
  return requests.filter(
    (request) => request.method === 'POST' && new URL(request.url, 'http://kernel.test').pathname === path,
  );
}

async function publicStatement(id: string, property: string, candidate: string): Promise<unknown> {
  const response = await fixture!.stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { subject: { statements?: Record<string, { id: string }[]> } };
  return body.subject.statements?.[property]?.find((statement) => statement.id === candidate) ?? null;
}

async function confirm(page: Page, operation: 'Share consent' | 'Retract assertion'): Promise<void> {
  await page.getByRole('button', { name: operation, exact: true }).click();
  await page.getByRole('checkbox', { name: 'This assertion targets the agent linked to my current account.' }).click();
  await serverAction(page, () => page.getByRole('button', { name: 'Confirm', exact: true }).click());
}

test('website consent discloses and terminally retracts an unsourced assertion through the native BFF', async () => {
  const current = fixture!;
  const alice = await current.auth.signIn('alice');
  const page = alice.context.pages()[0] ?? (await alice.context.newPage());
  page.setDefaultTimeout(30_000);

  expect(await publicStatement(current.own.id, current.own.property, current.own.candidate)).toBeNull();
  const accepted = await current.stack.kernel(
    `/v1/subjects/${current.own.id}/candidates?property=${encodeURIComponent(current.own.property)}&target=${current.own.slot.target}`,
    {},
    'alice',
  );
  expect(accepted.status).toBe(200);
  const listing = (await accepted.json()) as {
    candidates: { id: string; decision: string; retracted: number | null }[];
  };
  expect(listing.candidates).toContainEqual(
    expect.objectContaining({ id: current.own.candidate, decision: 'accepted', retracted: null }),
  );

  await openConsent(page, current.own);
  await serverAction(page, () => page.getByRole('button', { name: 'Open private review', exact: true }).click());
  await expect(page.getByText('River Ink', { exact: true })).toBeVisible();
  await expect(page.getByText(current.alice.agent.label, { exact: true })).toBeVisible();
  await expect(page.getByText('Eligibility is not supplied', { exact: false })).toBeVisible();
  await expect(
    page.getByText('The current public read does not include this assertion', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share consent', exact: true })).toBeVisible();

  const beforeShare = (await kernelNow()).length;
  await confirm(page, 'Share consent');
  await expect(page.getByText('Consent sharing is confirmed', { exact: false })).toBeVisible();
  const shareTraffic = (await kernelNow()).slice(beforeShare);
  const disclosePath = `/v1/statements/${current.own.candidate}/disclose`;
  expect(posts(shareTraffic, disclosePath)).toHaveLength(1);
  expect(posts(shareTraffic, disclosePath)[0]?.authorization).toMatch(/^Bearer /);
  expect(
    shareTraffic.some(
      (request) =>
        request.method === 'GET' &&
        new URL(request.url, 'http://kernel.test').pathname === `/v1/subjects/${current.own.id}` &&
        request.authorization === null,
    ),
  ).toBe(true);
  expect(await publicStatement(current.own.id, current.own.property, current.own.candidate)).not.toBeNull();

  const beforePublic = (await kernelNow()).length;
  await serverAction(page, () => page.getByRole('button', { name: 'Read current public result', exact: true }).click());
  expect(posts((await kernelNow()).slice(beforePublic), disclosePath)).toHaveLength(0);
  expect(
    posts((await kernelNow()).slice(beforePublic), `/v1/statements/${current.own.candidate}/retract`),
  ).toHaveLength(0);

  const bob = await current.auth.signIn('bob');
  const other = bob.context.pages()[0] ?? (await bob.context.newPage());
  other.setDefaultTimeout(30_000);
  await openConsent(other, current.own);
  await serverAction(other, () => other.getByRole('button', { name: 'Open private review', exact: true }).click());
  const otherRetract = other.getByRole('button', { name: 'Retract assertion', exact: true });
  if ((await otherRetract.count()) > 0) {
    await confirm(other, 'Retract assertion');
    await expect(other.getByText('not permitted for the current account', { exact: false })).toBeVisible();
  } else {
    await expect(other.getByRole('button', { name: 'Share consent', exact: true })).toHaveCount(0);
  }
  expect(await publicStatement(current.own.id, current.own.property, current.own.candidate)).not.toBeNull();

  const beforeRetract = (await kernelNow()).length;
  await confirm(page, 'Retract assertion');
  await expect(page.getByText('terminally retracted', { exact: false })).toBeVisible();
  await expect(page.getByText('no undo', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share consent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retract assertion', exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain(current.own.slot.target);
  const retractPath = `/v1/statements/${current.own.candidate}/retract`;
  expect(posts((await kernelNow()).slice(beforeRetract), retractPath)).toHaveLength(1);
  expect(await publicStatement(current.own.id, current.own.property, current.own.candidate)).toBeNull();

  const beforeRefresh = (await kernelNow()).length;
  await serverAction(page, () => page.getByRole('button', { name: 'Read current public result', exact: true }).click());
  expect(posts((await kernelNow()).slice(beforeRefresh), retractPath)).toHaveLength(0);
  expect(posts((await kernelNow()).slice(beforeRefresh), disclosePath)).toHaveLength(0);

  await openConsent(page, current.sourced);
  await serverAction(page, () => page.getByRole('button', { name: 'Open private review', exact: true }).click());
  await expect(page.getByText('ordinary sourced review', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share consent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retract assertion', exact: true })).toHaveCount(0);
});

test('an uncertain website consent command retries the same native operation and key', async () => {
  const current = fixture!;
  const disclosePath = `/v1/statements/${current.uncertain.candidate}/disclose`;
  await current.stack.injectKernelFailureOnce({
    method: 'POST',
    path: disclosePath,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/unavailable',
      title: 'Unavailable',
      status: 503,
      code: 'unavailable',
      request_id: crypto.randomUUID(),
      retryable: true,
      effect_status: 'unknown',
    }),
  });
  const alice = await current.auth.signIn('alice', { context: await current.auth.newContext('alice') });
  const page = alice.context.pages()[0] ?? (await alice.context.newPage());
  page.setDefaultTimeout(30_000);
  await openConsent(page, current.uncertain);
  await serverAction(page, () => page.getByRole('button', { name: 'Open private review', exact: true }).click());
  const before = (await kernelNow()).length;
  await confirm(page, 'Share consent');
  await expect(page.getByText('The response is uncertain', { exact: false })).toBeVisible();
  const failed = posts((await kernelNow()).slice(before), disclosePath);
  expect(failed).toHaveLength(1);
  expect(failed[0]?.failure?.status).toBe(503);
  await serverAction(page, () => page.getByRole('button', { name: 'Retry confirmation', exact: true }).click());
  const retried = posts((await kernelNow()).slice(before), disclosePath);
  expect(retried).toHaveLength(2);
  expect(retried[1]?.idempotencyKey).toBe(retried[0]?.idempotencyKey);
  expect(retried[1]?.url).toBe(retried[0]?.url);
  await expect(page.getByText('Consent sharing is confirmed', { exact: false })).toBeVisible();
});
