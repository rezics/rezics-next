import { expect } from 'bun:test';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../../src/tokens/cursor.ts';
import {
  capture,
  costOf,
  seed,
  type Capture,
  type Cost,
  type GrowthDatabase,
} from '../../support/growth.ts';
import { purchaseHistoryFixture } from './purchase-history-fixture.ts';

export const pageLimit = 5;
export const depthPages = 8;
export const scales = [64, 512, 4096] as const;
export const axes = ['same-buyer history', 'same-route peer history', 'foreign-partition history'] as const;
export type GrowthAxis = (typeof axes)[number];

type Row = Record<string, unknown>;
type Page = { entitlements: { id: string }[]; next: string | null };
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

const windowRows = pageLimit * (depthPages + 1);
const sentinelStep = 8_000;

function nodes(value: unknown): PlanNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as PlanNode;
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

function routableId(base: string, step: number, salt: number, route: number): string {
  const bytes = Buffer.from(base.replaceAll('-', ''), 'hex');
  const timestamp = bytes.readUIntBE(0, 6);
  if (step >= timestamp) throw new RangeError('UUID timestamp underflow');
  bytes.writeUIntBE(timestamp - step, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  bytes.writeUInt32BE((Math.imul(step + 1, 0x9e3779b9) ^ salt) >>> 0, 12);
  bytes[10] = route >>> 8;
  bytes[11] = route & 0xff;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sessionId(orderId: string): string {
  return `cs_test_${orderId.replaceAll('-', '')}`;
}

function cloneGrant(
  order: Row,
  entitlement: Row,
  accountId: string,
  route: number,
  step: number,
): { 'commerce.purchase_order': Row[]; 'commerce.entitlement': Row[] } {
  const orderId = routableId(String(order.order_id), step, 1, route);
  const entitlementId = routableId(String(entitlement.entitlement_id), step, 2, route);
  return {
    'commerce.purchase_order': [
      {
        ...order,
        route,
        order_id: orderId,
        buyer_account_id: accountId,
        transaction_id: routableId(String(order.transaction_id), step, 3, route),
        checkout_session_id: sessionId(orderId),
        checkout_url: `https://checkout.stripe.com/c/pay/${sessionId(orderId)}`,
        payment_intent_id: order.payment_intent_id ? `pi_${orderId.replaceAll('-', '')}` : null,
      },
    ],
    'commerce.entitlement': [
      {
        ...entitlement,
        route,
        entitlement_id: entitlementId,
        account_id: accountId,
        order_id: orderId,
        transaction_id: routableId(String(entitlement.transaction_id), step, 4, route),
      },
    ],
  };
}

function pageSql(statements: readonly string[]): string[] {
  return statements.filter((text) => /FROM commerce\.entitlement/i.test(text) && /entitlement_id\s*</i.test(text));
}

export async function entitlementPageGrowth() {
  const f = await purchaseHistoryFixture();
  const buyer = f.people.alice;
  const peer = f.peer;
  const buyerRoute = routeOf(buyer.accountId)!;
  const buyerPartition = partitionOf(buyerRoute);
  const foreign =
    [f.people.bob, f.people.orgOwner, f.people.operator, f.people.staff].find(
      (person) => partitionOf(routeOf(person.accountId)!) !== buyerPartition,
    ) ??
    (() => {
      throw new Error('Native fixture supplied no foreign-partition person');
    })();
  expect(routeOf(peer.accountId)).toBe(buyerRoute);
  expect(partitionOf(routeOf(foreign.accountId)!)).not.toBe(buyerPartition);

  const paid = await f.checkout();
  f.fake.pay(paid.checkoutSessionId!);
  await f.event('checkout.session.completed', paid.checkoutSessionId!);
  const orderTemplate = (
    await f.db.admin.query<{ row: Row }>('SELECT to_jsonb(o) AS row FROM commerce.purchase_order o WHERE order_id=$1', [
      paid.id,
    ])
  ).rows[0]!.row;
  const entitlementTemplate = (
    await f.db.admin.query<{ row: Row }>('SELECT to_jsonb(e) AS row FROM commerce.entitlement e WHERE order_id=$1', [
      paid.id,
    ])
  ).rows[0]!.row;
  const selectedId = String(entitlementTemplate.entitlement_id);
  const sentinelId = routableId(selectedId, sentinelStep, 2, buyerRoute);
  const binding = { operation: 'entitlement.list', parameters: { accountId: buyer.accountId } };
  const unscoped = await f.people.unscoped('entitlement:list');

  await seed(
    f.db,
    {
      name: 'selected entitlement page window',
      hotPartition: buyerPartition,
      hotShare: 1,
      rows: ({ ordinal }) =>
        cloneGrant(
          orderTemplate,
          entitlementTemplate,
          buyer.accountId,
          buyerRoute,
          ordinal === windowRows ? sentinelStep : ordinal + 1,
        ),
    },
    { from: 0, to: windowRows + 1 },
  );

  let deepCursor = '';
  let emptyCursor = '';

  async function list(as: { bearer: string | null } = buyer, cursor?: string): Promise<Page> {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (cursor) query.set('cursor', cursor);
    const response = await f.request(`/v1/entitlements?${query}`, as);
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  }

  async function denied(path: string, as: { bearer: string | null }, status: number, code?: string) {
    const response = await f.request(path, as);
    expect(response.status).toBe(status);
    if (code) expect((await response.json()).code).toBe(code);
    return response;
  }

  async function refreshCursors() {
    const first = await list();
    expect(first.entitlements).toHaveLength(pageLimit);
    expect(first.entitlements[0]!.id).toBe(selectedId);
    expect(first.next).toBeString();
    let cursor = first.next!;
    for (let page = 1; page < depthPages; page++) {
      const body = await list(buyer, cursor);
      expect(body.entitlements).toHaveLength(pageLimit);
      expect(body.next).toBeString();
      cursor = body.next!;
    }
    deepCursor = cursor;
    const decoded = decodeCursor(f.keys, binding, first.next!);
    if (!decoded.ok) throw new Error('Public entitlement cursor failed to decode');
    emptyCursor = encodeCursor(f.keys, binding, { epoch: decoded.epoch, after: [sentinelId] });
  }

  function disclose(page: Page) {
    expect(page.entitlements.map((row) => row.id)).not.toContain(undefined);
    for (const row of page.entitlements) expect(Object.keys(row)).not.toContain('accountId');
  }

  function assertPage(measured: Capture, examined: number) {
    const sql = pageSql(measured.statements);
    expect(sql).toHaveLength(1);
    expect(sql[0]!).toMatch(/account_id\s*=/);
    expect(sql[0]!).toMatch(/entitlement_id\s*</);
    expect(sql[0]!).not.toMatch(/\bOFFSET\b|\bCOUNT\s*\(/i);
    const keysets = nodes(measured.plans).filter((node) => node['Index Name'] === 'entitlement_account_page');
    expect(keysets.length).toBeGreaterThan(0);
    for (const plan of keysets) {
      expect(String(plan['Index Cond'])).toContain('route =');
      expect(String(plan['Index Cond'])).toContain('account_id =');
      expect(String(plan['Index Cond'])).toContain('entitlement_id <');
      expect(Number(plan['Rows Removed by Filter'] ?? 0)).toBe(0);
      expect(Number(plan['Actual Rows'])).toBe(examined);
    }
    expect(costOf(measured).relations['commerce.entitlement']?.sequentialScans ?? 0).toBe(0);
  }

  async function grow(axis: GrowthAxis, database: GrowthDatabase, scale: number, previous: number) {
    const person = axis === 'same-buyer history' ? buyer : axis === 'same-route peer history' ? peer : foreign;
    const route = routeOf(person.accountId)!;
    await seed(
      database,
      {
        name: `entitlement page ${axis}`,
        hotPartition: partitionOf(route),
        hotShare: 1,
        rows: ({ ordinal }) =>
          cloneGrant(
            orderTemplate,
            entitlementTemplate,
            person.accountId,
            route,
            axis === 'same-buyer history' ? windowRows + 1 + ordinal : ordinal + 1,
          ),
      },
      { from: previous, to: scale },
    );
  }

  async function pages() {
    const first = await list();
    expect(first.entitlements).toHaveLength(pageLimit);
    expect(first.entitlements[0]!.id).toBe(selectedId);
    disclose(first);
    const deep = await list(buyer, deepCursor);
    expect(deep.entitlements).toHaveLength(pageLimit);
    expect(deep.entitlements[0]!.id).not.toBe(selectedId);
    expect(deep.next).toBeString();
    disclose(deep);
    const empty = await list(buyer, emptyCursor);
    expect(empty).toEqual({ entitlements: [], next: null });
  }

  async function controls() {
    await denied('/v1/entitlements', f.people.anonymous, 401);
    await denied('/v1/entitlements', unscoped, 403, 'forbidden');
    await denied(`/v1/entitlements?cursor=${encodeURIComponent(deepCursor)}`, peer, 400, 'invalid_cursor');
    expect((await list(peer)).entitlements.map((row) => row.id)).not.toContain(selectedId);
    expect((await list(foreign)).entitlements.map((row) => row.id)).not.toContain(selectedId);
  }

  async function assertClosedControls() {
    for (const run of [
      () => denied('/v1/entitlements', f.people.anonymous, 401),
      () => denied('/v1/entitlements', unscoped, 403, 'forbidden'),
      () => denied(`/v1/entitlements?cursor=${encodeURIComponent(deepCursor)}`, peer, 400, 'invalid_cursor'),
    ]) {
      const measured = await capture(f.db, run, { includeBackends: true });
      expect(pageSql(measured.capture.statements)).toEqual([]);
      expect(costOf(measured.capture).relations['commerce.entitlement']?.rows ?? 0).toBe(0);
    }
    expect((await list(peer)).entitlements.map((row) => row.id)).not.toContain(selectedId);
    expect((await list(foreign)).entitlements.map((row) => row.id)).not.toContain(selectedId);
  }

  async function warmupPages() {
    const first = await capture(f.db, () => list(), { includeBackends: true });
    disclose(first.value);
    expect(first.value.entitlements[0]!.id).toBe(selectedId);
    assertPage(first.capture, pageLimit + 1);
    const deep = await capture(f.db, () => list(buyer, deepCursor), { includeBackends: true });
    disclose(deep.value);
    expect(deep.value.entitlements).toHaveLength(pageLimit);
    assertPage(deep.capture, pageLimit + 1);
    const empty = await capture(f.db, () => list(buyer, emptyCursor), { includeBackends: true });
    expect(empty.value).toEqual({ entitlements: [], next: null });
    assertPage(empty.capture, 0);
  }

  return {
    db: f.db,
    selectedId,
    grow,
    refreshCursors,
    pages,
    controls,
    assertClosedControls,
    warmupPages,
    entitlementCost(cost: Cost) {
      const found = Object.entries(cost.relations).find(
        ([name]) => /entitlement/.test(name) && !name.startsWith('index:'),
      );
      expect(found).toBeDefined();
      return found![1];
    },
    async close() {
      await f.close();
    },
  };
}

export type EntitlementPageGrowth = Awaited<ReturnType<typeof entitlementPageGrowth>>;
