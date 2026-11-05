import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { subjectHref } from '../../src/subject/subject-href';
import {
  startNativeCreatorOfferSalesFixture,
  taxCode,
  type NativeCreatorOfferSalesFixture,
} from './native-creator-offer-sales-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCreatorOfferSalesFixture | undefined;
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function ready(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: join(fixture!.evidenceDir, name),
    fullPage: true,
  });
}

test('creator publishes an eligible edition offer, finds it on the Subject, revises, delists and inspects a signed test-mode sale', async () => {
  fixture = await startNativeCreatorOfferSalesFixture();
  const { edition, stack, accountIds } = fixture;
  const evidence: Record<string, unknown> = {
    editionId: edition.contentEditionId,
    subjectId: edition.targetSubjectId,
    revisionId: edition.revisionId,
    sha256: edition.sha256,
    personas: { creator: accountIds.alice, unrelated: accountIds.bob, buyer: accountIds.buyer },
  };

  const creator = await fixture.signIn('alice');
  const creatorPage = creator.context.pages().at(-1) ?? (await creator.context.newPage());
  creatorPage.setDefaultTimeout(30_000);
  await creatorPage.goto(`${stack.web}/en/editions`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: 'Your editions' }).waitFor();
  await creatorPage.getByRole('link', { name: 'Create offer' }).click();
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: 'New offer' }).waitFor();
  await creatorPage.getByText('Edition technical details (optional)').click();
  expect(await creatorPage.getByText(edition.contentEditionId, { exact: true }).count()).toBe(1);
  expect(await creatorPage.getByText(edition.revisionId, { exact: true }).count()).toBe(1);
  expect(await creatorPage.getByText(edition.sha256, { exact: true }).count()).toBe(1);
  await creatorPage.getByLabel('Offer title').fill(edition.title);
  await creatorPage.getByLabel('Sale currency').selectOption('usd');
  await creatorPage.getByLabel('Price before tax').fill('12.00');
  await creatorPage.getByLabel('Product tax code').fill(taxCode);
  await screenshot(creatorPage, 'creator-offer-editor-en-1440-light.png');
  await creatorPage.getByRole('button', { name: 'Create offer' }).click();
  const viewOffer = creatorPage.getByRole('link', { name: 'View offer' });
  await viewOffer.waitFor();
  const publicHref = await viewOffer.getAttribute('href');
  expect(publicHref).toMatch(/\/en\/offers\/[0-9a-f-]{36}$/i);
  const offerId = publicHref!.split('/').at(-1)!;
  evidence.offerId = offerId;

  const listed = await fixture.kernel<{ offers: { id: string; state: string; revision: number; unitAmountMinor: number }[] }>(
    '/v1/offers',
    'alice',
  );
  expect(listed.status).toBe(200);
  const owned = listed.body.offers.find((row) => row.id === offerId);
  expect(owned).toMatchObject({ id: offerId, state: 'active', revision: 1, unitAmountMinor: 1200 });
  const publicOffer = await fixture.kernel<{ offer: { id: string; revision: number; unitAmountMinor: number } }>(
    `/v1/offers/${offerId}`,
  );
  expect(publicOffer.status).toBe(200);
  expect(publicOffer.body.offer).toMatchObject({ id: offerId, revision: 1, unitAmountMinor: 1200 });

  const directory = await fixture.waitSubjectOffer(offerId);
  expect(directory).toMatchObject({
    id: offerId,
    targetSubjectId: edition.targetSubjectId,
    title: edition.title,
    unitAmountMinor: 1200,
    revision: 1,
  });
  evidence.subjectOffer = { id: directory.id, revision: directory.revision };

  const anonymous = await fixture.anonymousPage();
  anonymous.setDefaultTimeout(30_000);
  const subjectUrl = new URL(subjectHref({ id: edition.targetSubjectId, label: edition.subjectTitle }, 'en').href, stack.web)
    .href;
  await anonymous.goto(subjectUrl, { waitUntil: 'domcontentloaded' });
  await ready(anonymous);
  await anonymous.getByRole('heading', { name: 'Offers for this subject' }).waitFor();
  expect(await anonymous.getByText(edition.title, { exact: true }).count()).toBe(1);
  await screenshot(anonymous, 'subject-offers-anonymous-en-1440-light.png');
  await anonymous.setViewportSize({ width: 390, height: 844 });
  expect(await anonymous.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(anonymous, 'subject-offers-anonymous-en-390-light.png');
  await anonymous.evaluate(() => {
    document.cookie = 'rezics_theme=dark; Path=/; SameSite=Lax';
  });
  await anonymous.reload({ waitUntil: 'domcontentloaded' });
  await ready(anonymous);
  await anonymous.getByRole('heading', { name: 'Offers for this subject' }).waitFor();
  await screenshot(anonymous, 'subject-offers-anonymous-en-390-dark.png');
  await anonymous.setViewportSize({ width: 1440, height: 900 });
  await anonymous.goto(new URL(subjectHref({ id: edition.targetSubjectId, label: edition.subjectTitle }, 'ja').href, stack.web).href, {
    waitUntil: 'domcontentloaded',
  });
  await ready(anonymous);
  await anonymous.getByRole('heading', { name: 'この項目の販売オファー' }).waitFor();
  await anonymous.goto(
    new URL(subjectHref({ id: edition.targetSubjectId, label: edition.subjectTitle }, 'zh-Hant').href, stack.web).href,
    { waitUntil: 'domcontentloaded' },
  );
  await ready(anonymous);
  await anonymous.getByRole('heading', { name: '此主題的方案' }).waitFor();
  await anonymous.close();

  await fixture.grantBuyer(offerId);
  const buyer = await fixture.signIn('outsider');
  const buyerPage = await buyer.context.newPage();
  buyerPage.setDefaultTimeout(30_000);
  await buyerPage.route('https://checkout.stripe.com/**', (route) => route.abort());
  await buyerPage.goto(`${stack.web}/en/offers/${offerId}`, { waitUntil: 'domcontentloaded' });
  await ready(buyerPage);
  const createResponse = buyerPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/checkout' && response.request().method() === 'POST',
  );
  await buyerPage.getByRole('button', { name: /buy/i }).click();
  const created = await createResponse;
  expect(created.status()).toBe(200);
  const checkout = (await created.json()) as { checkoutUrl: string };
  const sessionId = new URL(checkout.checkoutUrl).pathname.split('/').at(-1)!;
  const providerSession = fixture.stripe.sessions.get(sessionId);
  expect(providerSession?.client_reference_id).toEqual(expect.any(String));
  const orderId = providerSession!.client_reference_id!;
  evidence.orderId = orderId;
  await fixture.payOrder(orderId);
  const paid = await fixture.kernel<{
    order: { id: string; offerId: string; unitAmountMinor: number; settlement: string; offerRevision: number };
  }>(`/v1/orders/${orderId}`, 'outsider');
  expect(paid.status).toBe(200);
  expect(paid.body.order).toMatchObject({
    id: orderId,
    offerId,
    unitAmountMinor: 1200,
    settlement: 'paid',
    offerRevision: 1,
  });
  await buyerPage.goto(`${stack.web}/en/orders/${orderId}`, { waitUntil: 'domcontentloaded' });
  await ready(buyerPage);
  expect(await buyerPage.getByRole('heading', { name: /receipt/i }).count()).toBe(1);
  await screenshot(buyerPage, 'buyer-order-en-1440-light.png');
  await buyerPage.close();

  await creatorPage.setViewportSize({ width: 1440, height: 900 });
  await creatorPage.goto(`${stack.web}/en/creator/offers`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: 'Your offers' }).waitFor();
  expect(await creatorPage.getByText(edition.title, { exact: true }).count()).toBeGreaterThan(0);
  await creatorPage
    .getByRole('button', { name: `Inspect ${edition.title}, offer ${offerId}, revision 1` })
    .click();
  await creatorPage.locator('#creator-offer-inspection').waitFor();
  await screenshot(creatorPage, 'creator-offer-inspect-en-1440-light.png');
  await creatorPage.getByRole('button', { name: 'Manage price or delist' }).click();
  await creatorPage.getByLabel('Price before tax').fill('18.00');
  await creatorPage.getByRole('button', { name: 'Save new price' }).click();
  await creatorPage.getByText('Change recorded', { exact: false }).waitFor();
  const revised = await fixture.kernel<{ offer: { revision: number; unitAmountMinor: number } }>(
    `/v1/offers/${offerId}`,
    'alice',
  );
  expect(revised.status).toBe(200);
  expect(revised.body.offer).toMatchObject({ revision: 2, unitAmountMinor: 1800 });
  const capturedOrder = await fixture.kernel<{ order: { unitAmountMinor: number; offerRevision: number } }>(
    `/v1/orders/${orderId}`,
    'outsider',
  );
  expect(capturedOrder.body.order).toMatchObject({ unitAmountMinor: 1200, offerRevision: 1 });

  const sale = await fixture.waitCreatorSale(orderId);
  expect(sale).toMatchObject({
    orderId,
    offerId,
    title: edition.title,
    targetSubjectId: edition.targetSubjectId,
    unitAmountMinor: 1200,
    settlement: 'paid',
  });
  evidence.sale = sale;
  await creatorPage.goto(`${stack.web}/en/creator/sales`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: 'Sales history' }).waitFor();
  expect(await creatorPage.getByText(orderId, { exact: true }).count()).toBeGreaterThan(0);
  await creatorPage.getByRole('button', { name: 'Inspect sale' }).click();
  await creatorPage.locator('#creator-sale-inspection').waitFor();
  expect(await creatorPage.getByText('Charged unit price').count()).toBe(1);
  expect(await creatorPage.locator('#creator-sale-inspection').getByText(orderId, { exact: true }).count()).toBeGreaterThan(
    0,
  );
  expect(await creatorPage.locator('#creator-sale-inspection').getByText(offerId, { exact: true }).count()).toBeGreaterThan(
    0,
  );
  await screenshot(creatorPage, 'creator-sale-inspect-en-1440-light.png');
  await creatorPage.setViewportSize({ width: 390, height: 844 });
  await screenshot(creatorPage, 'creator-sale-inspect-en-390-light.png');
  await creatorPage.getByRole('button', { name: 'Close and return to sales' }).click();
  expect(await creatorPage.locator('#creator-sales-heading').isVisible()).toBe(true);

  await creatorPage.setViewportSize({ width: 1440, height: 900 });
  await creatorPage.goto(`${stack.web}/en/creator/offers`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('button', { name: 'Manage price or delist' }).click();
  await creatorPage.getByRole('button', { name: 'Delist' }).click();
  await creatorPage.getByText('Change recorded', { exact: false }).waitFor();
  const delisted = await fixture.kernel<{ offers: { id: string; state: string }[] }>('/v1/offers', 'alice');
  expect(delisted.body.offers.find((row) => row.id === offerId)?.state).toBe('delisted');
  const concealed = await fixture.kernel(`/v1/offers/${offerId}`);
  expect([404, 403]).toContain(concealed.status);
  const saleAfterDelist = await fixture.kernel<{ sales: { orderId: string; unitAmountMinor: number }[] }>(
    '/v1/commerceSales?limit=20',
    'alice',
  );
  expect(saleAfterDelist.body.sales.find((row) => row.orderId === orderId)).toMatchObject({
    orderId,
    unitAmountMinor: 1200,
  });

  const unrelated = await fixture.signIn('bob');
  const bobPage = unrelated.context.pages().at(-1) ?? (await unrelated.context.newPage());
  bobPage.setDefaultTimeout(20_000);
  await bobPage.goto(`${stack.web}/en/creator/offers`, { waitUntil: 'domcontentloaded' });
  await ready(bobPage);
  await bobPage.getByRole('heading', { name: 'Your offers' }).waitFor();
  expect(await bobPage.getByText(offerId, { exact: true }).count()).toBe(0);
  const bobOffers = await fixture.kernel<{ offers: { id: string }[] }>('/v1/offers', 'bob');
  expect(bobOffers.status).toBe(200);
  expect(bobOffers.body.offers.some((row) => row.id === offerId)).toBe(false);
  await bobPage.goto(`${stack.web}/en/creator/sales`, { waitUntil: 'domcontentloaded' });
  await ready(bobPage);
  expect(await bobPage.getByText(orderId, { exact: true }).count()).toBe(0);
  const bobSales = await fixture.kernel<{ sales: { orderId: string }[] }>('/v1/commerceSales?limit=20', 'bob');
  expect(bobSales.status).toBe(200);
  expect(bobSales.body.sales.some((row) => row.orderId === orderId)).toBe(false);
  await bobPage.close();

  for (const [locale, heading] of [
    ['en', 'Your offers'],
    ['ja', '自分のオファー'],
    ['zh-Hant', '我的報價'],
  ] as const) {
    await creatorPage.goto(`${stack.web}/${locale}/creator/offers`, { waitUntil: 'domcontentloaded' });
    await ready(creatorPage);
    await creatorPage.getByRole('heading', { name: heading }).waitFor();
  }
  await creatorPage.goto(`${stack.web}/ja/creator/sales`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: '販売履歴' }).waitFor();
  await creatorPage.goto(`${stack.web}/zh-Hant/creator/sales`, { waitUntil: 'domcontentloaded' });
  await ready(creatorPage);
  await creatorPage.getByRole('heading', { name: '銷售紀錄' }).waitFor();
  await screenshot(creatorPage, 'creator-sales-zh-Hant-1440-light.png');

  await writeFile(join(fixture.evidenceDir, 'walk.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
});
