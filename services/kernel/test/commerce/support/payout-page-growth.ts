import { expect } from 'bun:test';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createCommerceCommands } from '../../../src/commerce/commands.ts';
import { createPayouts } from '../../../src/commerce/payouts.ts';
import type { CheckoutSnapshot, Order, StripeTransaction } from '../../../src/commerce/model.ts';
import { readOrder } from '../../../src/commerce/store.ts';
import { derivedId, newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { capture, costOf, openGrowthDatabase, seed, type Capture, type GrowthDatabase } from '../../support/growth.ts';
import { nativeFixture } from '../../access/native-account-bindings-fixture.ts';
import { createPersonas, type Persona } from '../../support/personas.ts';
import { testKernel } from '../../support/test-kernel.ts';

export const PAGE = 5;
export const REMAINING = 16;
export const NATIVE = 24;
export const SCALES = [32, 128, 512] as const;
export const AXES = ['unrelated creators', 'selected statement history', 'selected statement lines'] as const;
export const JOBS = ['first', 'deep', 'exhausted-empty', 'denied'] as const;
export type PayoutPageAxis = (typeof AXES)[number];
export type PayoutPageJob = (typeof JOBS)[number];
type Row = Record<string, unknown>;

function nodes(value: unknown): Row[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value as Row, ...Object.values(value).flatMap(nodes)];
}

function moneyKey(ordinal: number): { currency: string; period: string } {
  const value = ordinal % 210_900;
  let code = value % 17_575;
  if (code >= 14_511) code++;
  const currency = `${String.fromCharCode(97 + Math.floor(code / 676))}${String.fromCharCode(97 + Math.floor((code % 676) / 26))}${String.fromCharCode(97 + (code % 26))}`;
  const month = 1 + Math.floor(value / 17_575);
  return { currency, period: `2024-${String(month).padStart(2, '0')}` };
}

function charge(currency: string): StripeTransaction {
  return {
    id: `txn_${Bun.randomUUIDv7().replaceAll('-', '')}`,
    kind: 'charge',
    sourceId: 'ch_sale',
    currency,
    amountMinor: 1000,
    feeMinor: 0,
    netMinor: 1000,
    feeDetails: [],
    exchangeRate: currency === 'usd' ? null : 1,
    created: '2025-12-01T00:00:00.000Z',
  };
}

function snapshot(order: Order, transactions: StripeTransaction[]): CheckoutSnapshot {
  return {
    sessionId: order.checkoutSessionId!,
    clientReferenceId: order.id,
    metadataOrderId: order.id,
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: 'usd',
    amountSubtotalMinor: order.unitAmountMinor,
    amountTaxMinor: 0,
    amountTotalMinor: order.unitAmountMinor,
    paymentIntentId: 'pi_sale',
    paymentIntentStatus: 'succeeded',
    chargeId: 'ch_sale',
    chargeAmountMinor: order.unitAmountMinor,
    refunds: [],
    disputes: [],
    transactions,
    observedAt: '2026-01-20T12:00:00.000Z',
  };
}

/** Exhausted-empty is an authorized owner with no rows: a public next cursor exists only when another page remains. */
export async function payoutPageGrowthFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const auth = await nativeFixture(db.pool);
  const app = testKernel({
    pool: db.pool,
    writeRate: createWriteRateLimiter({
      secret: 'payout-page-growth-native-rate-secret-32',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
    auth: { ...auth.host.service.verifier, fetch: (url, init) => auth.host.service.handler(new Request(url, init)) },
  });
  const people = await createPersonas(app, { version: 1, pool: db.pool, auth });
  const creator = people.alice;
  const buyer = people.bob;
  const denied = people.bob;
  const empty = people.orgOwner;
  const route = routeOf(creator.accountId)!;
  const hotPartition = partitionOf(route);
  const context = () => ({ pool: db.pool, deadline: Date.now() + 30_000 });
  const access = app.testAccess;
  async function actor(person: Persona) {
    return access.authenticate(person.bearer, context());
  }
  async function request(path: string, as: Persona, body?: unknown) {
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${as.bearer}`,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  expect((await request('/v1/platform/exposure/selling:open', people.staff, {})).status).toBe(200);
  await createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' }).create(
    { ...context(), actor: await actor(people.staff) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: creator.accountId },
      actions: ['offer:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  const commands = createCommerceCommands({ pool: db.pool, access });
  const offer = (
    await commands.createOffer(
      await actor(creator),
      {
        targetSubjectId: newId(0x5500),
        title: 'Payout page growth',
        currency: 'usd',
        unitAmountMinor: 1000,
        taxCode: 'txcd_10302000',
      },
      Bun.randomUUIDv7(),
    )
  ).value;
  const created = (await commands.createOrder(await actor(buyer), offer.id, offer.revision, Bun.randomUUIDv7())).value;
  await commands.recordCheckout(created.id, {
    session: {
      id: `cs_test_${Bun.randomUUIDv7().replaceAll('-', '')}`,
      url: 'https://checkout.test',
      expiresAt: '2026-01-20T14:00:00Z',
    },
  });
  const order = (await readOrder(db.pool, routeOf(buyer.accountId)!, created.id))!;
  const extraCurrencies: string[] = [];
  for (let index = 0; extraCurrencies.length < NATIVE - 1; index++) {
    const { currency } = moneyKey(index);
    if (currency === 'usd' || extraCurrencies.includes(currency)) continue;
    extraCurrencies.push(currency);
  }
  const usdCharges = Array.from({ length: NATIVE }, () => charge('usd'));
  const otherCharges = extraCurrencies.slice(0, NATIVE - 1).map((currency) => charge(currency));
  await commands.applyCheckoutSnapshot(snapshot(order, [...usdCharges, ...otherCharges]), Bun.randomUUIDv7());
  const payouts = createPayouts({ pool: db.pool, clock: () => new Date('2026-01-20T12:00:00Z') });
  const recorded = await payouts.recordTransactions(
    order.id,
    [...usdCharges, ...otherCharges].map((item) => item.id),
    'payout-page-growth-native',
  );
  if ('changed' in recorded && !recorded.changed) throw new Error('Native royalty recording created no statements');
  const listed = await request('/v1/payoutStatements?limit=100', creator);
  expect(listed.status).toBe(200);
  const nativeStatements = ((await listed.json()) as { payoutStatements: { id: string }[] }).payoutStatements;
  expect(nativeStatements.length).toBeGreaterThanOrEqual(NATIVE);
  const usdStatement = (
    await db.admin.query<{ statement_id: string }>(
      `SELECT statement_id FROM commerce.payout_statement
       WHERE route=$1 AND creator_account_id=$2 AND currency='usd' AND period='2026-01'`,
      [route, creator.accountId],
    )
  ).rows[0];
  if (!usdStatement) throw new Error('Native royalty recording did not create the selected USD statement');
  const selectedStatementId = usdStatement.statement_id;
  const nativeLineCount = (
    await db.admin.query(
      'SELECT count(*)::int AS n FROM commerce.royalty_line WHERE route=$1 AND statement_id=$2',
      [route, selectedStatementId],
    )
  ).rows[0]!.n as number;
  expect(nativeLineCount).toBe(NATIVE);
  const statementTemplate = (
    await db.admin.query<Row>('SELECT * FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2', [
      route,
      selectedStatementId,
    ])
  ).rows[0]!;
  const lineTemplate = (
    await db.admin.query<Row>('SELECT * FROM commerce.royalty_line WHERE route=$1 AND statement_id=$2 LIMIT 1', [
      route,
      selectedStatementId,
    ])
  ).rows[0]!;
  const nativeIds = (
    await db.admin.query<{ statement_id: string }>(
      'SELECT statement_id FROM commerce.payout_statement WHERE route=$1 AND creator_account_id=$2',
      [route, creator.accountId],
    )
  ).rows.map((row) => row.statement_id);
  const minNativeId = nativeIds.reduce((min, id) => (id < min ? id : min));
  let moneyOrdinal = 400;
  const usedKeys = new Set(nativeIds);
  function placeOlderStatement() {
    for (let attempt = 0; attempt < 1_000_000; attempt++) {
      const key = moneyKey(moneyOrdinal++);
      const id = derivedId(creator.accountId, `${key.period}:${key.currency}`, route);
      if (usedKeys.has(id) || id >= minNativeId) continue;
      usedKeys.add(id);
      return { id, ...key };
    }
    throw new Error('Could not place a statement older than the native neighborhood');
  }
  const emptyLine = placeOlderStatement();
  await db.admin.query(
    `INSERT INTO commerce.payout_statement
       (route, statement_id, creator_account_id, period, currency, gross_minor, tax_minor, fee_minor,
        dispute_fee_minor, refunds_minor, chargebacks_minor, net_receipts_minor, weighted_net_minor, state, revision)
     VALUES ($1,$2,$3,$4,$5,0,0,0,0,0,0,0,0,'open',1)`,
    [route, emptyLine.id, creator.accountId, emptyLine.period, emptyLine.currency],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_id, subject_role, grant_role, valid, transaction_id)
     VALUES ($1,$2,$3,'','commerce.payout.owner','(,)',$4)`,
    [routeOf(empty.accountId), empty.accountId, empty.accountId, newId(routeOf(empty.accountId)!)],
  );
  await seed(
    db,
    {
      name: 'Payout page background creators',
      hotPartition,
      hotShare: 0.5,
      rows: ({ ordinal, route: placedRoute }) => unrelatedRows(placedRoute, ordinal + 50_000),
    },
    { from: 0, to: 1024 },
  );
  let statements = nativeIds.length + 1;
  let lines = nativeLineCount;
  let lineGeneration = 0;
  let deepStatements: string | undefined;
  let deepLines: string | undefined;

  function statementRow(id: string, creatorId: string, placedRoute: number, period: string, currency: string): Row {
    return {
      ...statementTemplate,
      route: placedRoute,
      statement_id: id,
      creator_account_id: creatorId,
      period,
      currency,
      paid_at: null,
      paid_reference: null,
      state: 'open',
    };
  }
  function unrelatedRows(placedRoute: number, ordinal: number) {
    const creatorId = newId(placedRoute);
    const key = moneyKey(ordinal);
    const id = derivedId(creatorId, `${key.period}:${key.currency}`, placedRoute);
    return {
      'access.account': [
        {
          route: placedRoute,
          account_id: creatorId,
          kind: 'actor',
          state: 'active',
          transaction_id: creatorId,
        },
      ],
      'access.resource_role_grant': [
        {
          route: placedRoute,
          resource_id: creatorId,
          subject_id: creatorId,
          subject_role: '',
          grant_role: 'commerce.payout.owner',
          valid: '(,)',
          transaction_id: newId(placedRoute),
        },
      ],
      'commerce.payout_statement': [statementRow(id, creatorId, placedRoute, key.period, key.currency)],
    };
  }

  async function listStatements(as: Persona, cursor?: string) {
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) });
    const response = await request(`/v1/payoutStatements?${query}`, as);
    return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() };
  }
  async function listLines(as: Persona, statementId: string, cursor?: string) {
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) });
    const response = await request(`/v1/payoutStatements/${statementId}/lines?${query}`, as);
    return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() };
  }
  async function walk(total: number, read: (cursor?: string) => Promise<{ items: unknown[]; next: string | null }>) {
    const pages = Math.floor((total - REMAINING) / PAGE);
    if (pages < 1) throw new Error('The native neighborhood must yield a public deep cursor');
    let cursor: string | undefined;
    for (let page = 0; page < pages; page++) {
      const result = await read(cursor);
      expect(result.items).toHaveLength(PAGE);
      expect(result.next).toBeString();
      cursor = result.next!;
    }
    return cursor!;
  }

  async function operate(job: PayoutPageJob, axis: PayoutPageAxis) {
    const surface = axis === 'selected statement lines' ? 'lines' : 'statements';
    if (job === 'denied') {
      const page =
        surface === 'lines' ? await listLines(denied, selectedStatementId) : await listStatements(denied);
      expect(page.status).toBe(404);
      return;
    }
    if (job === 'exhausted-empty') {
      if (surface === 'lines') {
        const page = await listLines(creator, emptyLine.id);
        expect(page.status).toBe(200);
        const body = page.body as { lines: unknown[]; next: string | null };
        expect(body.lines).toEqual([]);
        expect(body.next).toBeNull();
        return;
      }
      const page = await listStatements(empty);
      expect(page.status).toBe(200);
      const body = page.body as { payoutStatements: unknown[]; next: string | null };
      expect(body.payoutStatements).toEqual([]);
      expect(body.next).toBeNull();
      return;
    }
    if (surface === 'lines') {
      const page = await listLines(creator, selectedStatementId, job === 'deep' ? deepLines : undefined);
      expect(page.status).toBe(200);
      const body = page.body as { lines: { statementId: string }[]; next: string | null };
      expect(body.lines).toHaveLength(PAGE);
      expect(body.next).toBeString();
      for (const row of body.lines) expect(row.statementId).toBe(selectedStatementId);
      return;
    }
    const page = await listStatements(creator, job === 'deep' ? deepStatements : undefined);
    expect(page.status).toBe(200);
    const body = page.body as { payoutStatements: { creatorAccountId: string }[]; next: string | null };
    expect(body.payoutStatements).toHaveLength(PAGE);
    expect(body.next).toBeString();
    for (const row of body.payoutStatements) expect(row.creatorAccountId).toBe(creator.accountId);
  }

  return {
    db,
    creator,
    denied,
    empty,
    selectedStatementId,
    emptyLineStatementId: emptyLine.id,
    async grow(database: GrowthDatabase, axis: PayoutPageAxis, scale: number, previous: number) {
      if (axis === 'unrelated creators') {
        await seed(
          database,
          {
            name: 'Payout page unrelated creators',
            hotPartition,
            hotShare: 0.5,
            rows: ({ ordinal, route: placedRoute }) => unrelatedRows(placedRoute, ordinal),
          },
          { from: previous, to: scale },
        );
      } else if (axis === 'selected statement history') {
        const added = Array.from({ length: scale - previous }, () => placeOlderStatement());
        await seed(
          database,
          {
            name: 'Payout page selected statement history',
            hotPartition,
            hotShare: 1,
            rows: ({ ordinal }) => ({
              'commerce.payout_statement': [
                statementRow(
                  added[ordinal - previous]!.id,
                  creator.accountId,
                  route,
                  added[ordinal - previous]!.period,
                  added[ordinal - previous]!.currency,
                ),
              ],
            }),
          },
          { from: previous, to: scale },
        );
        statements += added.length;
      } else {
        if (previous === 0) lineGeneration++;
        await seed(
          database,
          {
            name: 'Payout page selected statement lines',
            hotPartition,
            hotShare: 1,
            rows: ({ ordinal }) => ({
              'commerce.royalty_line': [
                {
                  ...lineTemplate,
                  route,
                  statement_id: selectedStatementId,
                  creator_account_id: creator.accountId,
                  balance_transaction_id: `txn_s${String(lineGeneration).padStart(2, '0')}${String(ordinal).padStart(8, '0')}`,
                  order_id: lineTemplate.order_id,
                  offer_id: lineTemplate.offer_id,
                },
              ],
            }),
          },
          { from: previous, to: scale },
        );
        lines += scale - previous;
      }
      if (axis === 'selected statement lines') {
        deepLines = await walk(lines, async (cursor) => {
          const page = await listLines(creator, selectedStatementId, cursor);
          expect(page.status).toBe(200);
          const body = page.body as { lines: { statementId: string }[]; next: string | null };
          for (const row of body.lines) expect(row.statementId).toBe(selectedStatementId);
          return { items: body.lines, next: body.next };
        });
        return;
      }
      deepStatements = await walk(statements, async (cursor) => {
        const page = await listStatements(creator, cursor);
        expect(page.status).toBe(200);
        const body = page.body as { payoutStatements: { id: string; creatorAccountId: string }[]; next: string | null };
        for (const row of body.payoutStatements) expect(row.creatorAccountId).toBe(creator.accountId);
        return { items: body.payoutStatements, next: body.next };
      });
    },
    operate,
    async evidence(job: PayoutPageJob, axis: PayoutPageAxis) {
      const measured = await capture(db, () => operate(job, axis), { includeBackends: true });
      assertPayoutPageEvidence(measured.capture, job, axis === 'selected statement lines' ? 'lines' : 'statements');
    },
    async close() {
      await auth.close();
      await db.close();
    },
  };
}

export type PayoutPageFixture = Awaited<ReturnType<typeof payoutPageGrowthFixture>>;

export function assertPayoutPageEvidence(raw: Capture, job: PayoutPageJob, surface: 'statements' | 'lines') {
  const sql = raw.statements;
  expect(sql.some((text) => /access\.resource_role_grant|access\.resource_grant/i.test(text))).toBe(true);
  const relation = surface === 'lines' ? 'commerce.royalty_line' : 'commerce.payout_statement';
  const page =
    surface === 'lines'
      ? sql.filter((text) => /FROM commerce\.royalty_line/i.test(text))
      : sql.filter((text) => /FROM commerce\.payout_statement/i.test(text));
  const cost = costOf(raw);
  expect(cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
  if (job === 'denied') {
    expect(page).toHaveLength(0);
    expect(cost.relations[relation]?.rows ?? 0).toBe(0);
    return;
  }
  expect(page.length).toBeGreaterThan(0);
  expect(sql.filter((text) => /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(text)).length).toBeGreaterThan(0);
  for (const text of page) {
    expect(text).not.toMatch(/\bOFFSET\b|\bCOUNT\s*\(/i);
    if (surface === 'lines') {
      expect(text).toMatch(/statement_id\s*=/);
      expect(text).toMatch(/balance_transaction_id\s*>/);
    } else {
      expect(text).toMatch(/creator_account_id\s*=/);
      expect(text).toMatch(/statement_id\s*</);
    }
  }
  const plans = nodes(raw.plans);
  const indexName = surface === 'lines' ? 'royalty_line_statement_page' : 'payout_statement_creator_page';
  const keysets = plans.filter((node) => node['Index Name'] === indexName);
  expect(keysets.length).toBeGreaterThan(0);
  const examined = job === 'exhausted-empty' ? 0 : PAGE + 1;
  for (const plan of keysets) {
    const cond = String(plan['Index Cond'] ?? '');
    expect(cond).toContain('route =');
    if (surface === 'lines') {
      expect(cond).toContain('statement_id =');
      expect(cond).toContain('balance_transaction_id >');
    } else {
      expect(cond).toContain('creator_account_id =');
      expect(cond).toContain('statement_id <');
    }
    expect(Number(plan['Rows Removed by Filter'] ?? 0) + Number(plan['Rows Removed by Index Recheck'] ?? 0)).toBe(0);
    expect(Number(plan['Actual Rows'] ?? 0)).toBe(examined);
  }
  expect(cost.relations[relation]?.rows ?? 0).toBe(examined);
}
