import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  startNativeCreatorStatementsFixture,
  type NativeCreatorStatementsFixture,
} from './native-creator-statements-fixture.ts';

setDefaultTimeout(600_000);

let fixture: NativeCreatorStatementsFixture;

beforeAll(async () => {
  fixture = await startNativeCreatorStatementsFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

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
    expect(fixture.responses.otherCreatorWebDetail.status).toBe(200);
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
});
