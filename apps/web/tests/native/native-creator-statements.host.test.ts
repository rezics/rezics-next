import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import {
  startNativeCreatorStatementsFixture,
  type NativeCreatorStatementsFixture,
} from './native-creator-statements-fixture.ts';

setDefaultTimeout(600_000);

const evidence = join(import.meta.dir, '../../../.temp/creator-statements-walk');

let fixture: NativeCreatorStatementsFixture;

beforeAll(async () => {
  fixture = await startNativeCreatorStatementsFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function openStatement(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}

describe('native creator statements', () => {
  test('binds admitted provider records, owner reads, independent continuations, and served routes', async () => {
    expect(fixture.accounts.creator).not.toBe(fixture.accounts.otherCreator);
    expect(fixture.accounts.creator).not.toBe(fixture.accounts.payoutOperator);
    expect(fixture.accounts.buyer).not.toBe(fixture.accounts.creator);
    expect(fixture.responses.webhook.every((response) => response.status === 200)).toBe(true);

    expect(fixture.statements.paid).toMatchObject({
      creatorAccountId: fixture.accounts.creator,
      currency: 'usd',
      state: 'open',
      revision: 1,
    });
    expect(fixture.statements.paged).toMatchObject({ creatorAccountId: fixture.accounts.creator });
    expect(fixture.statements.otherCreator).toMatchObject({ creatorAccountId: fixture.accounts.otherCreator });
    expect(fixture.statements.paid.period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(fixture.statements.paid.moneyUnit).toMatchObject({ system: 'stripe-api', factsVersion: 'stripe-money-v1' });

    const paid = (await fixture.responses.markPaid.clone().json()).statement;
    expect(paid).toMatchObject({
      id: fixture.statements.paid.id,
      state: 'paid',
      paidReference: expect.stringMatching(/^external-test-reference:/),
      revision: fixture.statements.paid.revision + 1,
    });
    expect(Number.isFinite(Date.parse(paid.paidAt))).toBe(true);

    expect(fixture.responses.listFirst.status).toBe(200);
    expect(fixture.responses.listNext.status).toBe(200);
    expect(fixture.listCursor.length).toBeGreaterThan(0);
    expect(fixture.lines.first.lines).toHaveLength(1);
    expect(fixture.lines.next.lines).toHaveLength(1);
    expect(fixture.lines.first.next).toBe(fixture.lineCursor);
    expect(fixture.lines.next.next).toBeNull();
    expect(fixture.lines.next.lines[0]).toMatchObject({
      statementId: fixture.statements.paged.id,
      creatorAccountId: fixture.accounts.creator,
      kind: 'refund',
    });
    expect(fixture.lines.next.lines[0]!.grossMinor).toBeLessThan(0);
    expect(fixture.lines.next.lines[0]!.netReceiptsMinor).toBeLessThan(0);
    expect(fixture.lines.next.lines[0]!.period).toBe(fixture.statements.paged.period);
    expect(new Date(fixture.lines.next.lines[0]!.recordedAt).toISOString()).toBe(
      fixture.lines.next.lines[0]!.recordedAt,
    );

    const address = new URL(fixture.addresses.detailLineContinuation);
    expect(address.pathname).toBe(`/en/creator/statements/${fixture.statements.paged.id}`);
    expect(address.searchParams.get('cursor')).toBe(fixture.lineCursor);
    expect(address.searchParams.get('from')).toBe(fixture.listCursor);
    expect(fixture.lineCursor).not.toBe(fixture.listCursor);
    expect(fixture.responses.webList.status).toBe(200);
    expect(fixture.responses.webDetail.status).toBe(200);
    expect(fixture.responses.webPaidDetail.status).toBe(200);
    expect(fixture.responses.otherCreatorWebDetail.status).toBe(200);
    const creatorPaidHtml = await fixture.responses.webPaidDetail.clone().text();
    expect(creatorPaidHtml).toContain(paid.paidReference);
    expect(creatorPaidHtml).toContain(
      `recorded amount ${fixture.statements.paid.creatorShareMinor} ${fixture.statements.paid.currency.toUpperCase()}`,
    );
    const concealedHtml = await fixture.responses.otherCreatorWebDetail.clone().text();
    expect(concealedHtml).not.toContain(paid.paidReference);
    expect(concealedHtml).not.toContain(fixture.lines.next.lines[0]!.balanceTransactionId);

    expect(fixture.responses.otherCreatorDetail.status).toBe(404);
    expect(fixture.responses.suspendedList.status).toBe(404);
    const denied = `${await fixture.responses.otherCreatorDetail.clone().text()} ${await fixture.responses.suspendedList
      .clone()
      .text()}`;
    expect(denied).not.toContain(paid.paidReference);
    expect(denied).not.toContain(fixture.statements.paid.creatorAccountId);
    expect(Object.values(fixture.commandKeys).every((key) => key.length > 0)).toBe(true);
    expect(new Set(Object.values(fixture.commandKeys)).size).toBe(Object.values(fixture.commandKeys).length);
  });

  test('creator, operator attestation and unrelated pages match native facts after reopen and locale navigation', async () => {
    mkdirSync(evidence, { recursive: true });
    const paid = (await fixture.responses.markPaid.clone().json()).statement as {
      paidReference: string;
    };
    const alice = await fixture.auth.signIn('alice', { context: await fixture.auth.newContext('alice') });
    const bob = await fixture.auth.signIn('bob', { context: await fixture.auth.newContext('bob') });
    const views = [
      ['phone-light', { width: 390, height: 844 }, 'light'] as const,
      ['desktop-dark', { width: 1440, height: 900 }, 'dark'] as const,
    ];
    for (const [name, viewport, colorScheme] of views) {
      const page = await alice.context.newPage();
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openStatement(page, fixture.addresses.paidDetail);
      expect(await page.getByRole('heading', { name: 'Royalty statement' }).count()).toBe(1);
      expect(await page.getByText(paid.paidReference, { exact: true }).count()).toBe(1);
      expect(await page.getByText('External payment recorded').count()).toBe(1);
      expect(
        await page.getByText('Whether royalties are payable or funds are available is unknown.').count(),
      ).toBe(1);
      expect(await page.getByRole('link', { name: 'Back to statements' }).count()).toBe(1);
      await page.screenshot({ path: join(evidence, `alice-paid-${name}.png`) });
      await page.close();
    }

    const locales = [
      ['zh-Hant', '版稅結算單詳情', '返回結算單列表', '已記錄外部付款'],
      ['ja', 'ロイヤリティ明細の詳細', '明細一覧に戻る', '外部支払いの記録あり'],
    ] as const;
    for (const [locale, heading, back, paidLabel] of locales) {
      const page = await alice.context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await openStatement(page, fixture.addresses.paidDetail.replace('/en/', `/${locale}/`));
      expect(await page.getByRole('heading', { name: heading }).count()).toBe(1);
      expect(await page.getByText(paid.paidReference, { exact: true }).count()).toBe(1);
      expect(await page.getByText(paidLabel).count()).toBe(1);
      expect(await page.getByRole('link', { name: back }).count()).toBe(1);
      await page.screenshot({ path: join(evidence, `alice-paid-${locale}.png`) });
      await page.close();
    }

    const sales = await alice.context.newPage();
    await openStatement(sales, new URL('/en/creator/sales', fixture.stack.web).href);
    expect(await sales.getByRole('heading', { name: 'Sales history' }).count()).toBe(1);
    expect(await sales.getByText(paid.paidReference, { exact: true }).count()).toBe(0);
    expect(
      await sales.getByText('Whether royalties are payable or funds are available is unknown.').count(),
    ).toBe(0);
    await sales.getByRole('link', { name: 'Royalty statements' }).click();
    await sales.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(new URL(sales.url()).pathname).toBe('/en/creator/statements');
    await sales.goto(fixture.addresses.paidDetail, { waitUntil: 'domcontentloaded' });
    await sales.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(await sales.getByText(paid.paidReference, { exact: true }).count()).toBe(1);
    await sales.screenshot({ path: join(evidence, 'alice-sales-to-statement.png') });
    await sales.close();

    const restored = await alice.context.newPage();
    await openStatement(restored, fixture.addresses.detailLineContinuation);
    await restored.getByRole('link', { name: 'Back to statements' }).click();
    await restored.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(new URL(restored.url()).searchParams.get('cursor')).toBe(fixture.listCursor);
    expect(await restored.getByRole('heading', { name: 'Royalty statements' }).count()).toBe(1);
    await restored.reload({ waitUntil: 'domcontentloaded' });
    await restored.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(new URL(restored.url()).searchParams.get('cursor')).toBe(fixture.listCursor);
    await restored.goto(fixture.addresses.detailLineContinuation, { waitUntil: 'domcontentloaded' });
    await restored.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(new URL(restored.url()).searchParams.get('cursor')).toBe(fixture.lineCursor);
    expect(new URL(restored.url()).searchParams.get('from')).toBe(fixture.listCursor);
    await restored.close();

    const concealed = await bob.context.newPage();
    await openStatement(concealed, fixture.addresses.otherCreatorDetail);
    expect(await concealed.getByText(paid.paidReference, { exact: true }).count()).toBe(0);
    await concealed.screenshot({ path: join(evidence, 'bob-concealed.png') });
    await concealed.close();
  });
});
