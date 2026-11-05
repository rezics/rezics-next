import { expect, test } from 'bun:test';
import { capture, checkGrowth } from '../support/growth.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeAnchorFixture } from './support/checkout-anchor.ts';

// Real native commands and official SDK bytes at every scale. A missing producer is runtime RED,
// never a successful model benchmark or a measured zero-work sample.
for (const path of ['direct', 'PaymentIntent', 'known-paid', 'binding-mismatch'] as const) {
  test(`native checkout anchor ${path} stays anchored under 64/512/4096 unrelated orders and provider Sessions`, async () => {
    const f = await nativeAnchorFixture();
    try {
      const order = await f.checkout(true, true);
      const other = await f.checkout();
      const event = await f.event(order, path === 'PaymentIntent');
      if (path === 'binding-mismatch') {
        const provider = f.fake.sessions.get(order.checkoutSessionId!)!;
        provider.client_reference_id = other.id;
        provider.metadata = { order_id: other.id };
      }
      const selected = path === 'binding-mismatch' ? other : order;
      const expected =
        path === 'binding-mismatch'
          ? { kind: 'mismatch' }
          : {
              kind: 'anchor',
              anchor: { orderId: order.id, sessionId: order.checkoutSessionId },
            };
      const calls = path === 'known-paid' ? 0 : path === 'PaymentIntent' ? 2 : 1;
      const before = await f.state(order);
      const resolver = f.resolver();
      const operation = async () => {
        f.reset();
        const result =
          path === 'known-paid'
            ? await resolver.resolveKnownOrder({ orderId: order.id })
            : await resolver.resolveEvent(event);
        expect(result).toEqual(expected);
        f.assertWork(selected, calls);
        return {
          sends: f.requests.length,
          requestBytes: f.requests.reduce((n, r) => n + r.requestBytes, 0),
          responseBytes: f.requests.reduce((n, r) => n + r.responseBytes, 0),
          maximumNativeConnections: f.maximum(),
        };
      };
      const report = await checkGrowth(f.db, {
        name: `Native checkout anchor ${path}`,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        indexProbes: 1,
        includeBackends: true,
        counted: {
          read: (value) => value as Awaited<ReturnType<typeof operation>>,
          limits: { sends: calls, maximumNativeConnections: 1, connections: 1 },
          bounds: {
            sends: 'constant',
            requestBytes: 'constant',
            responseBytes: 'constant',
            maximumNativeConnections: 'constant',
          },
        },
        async grow(_, scale, previous) {
          for (let i = previous; i < scale; i++) {
            const decoy = await f.checkout();
            expect(partitionOf(routeOf(decoy.id)!)).toBe(partitionOf(routeOf(order.id)!));
            expect(decoy.id).not.toBe(order.id);
          }
          console.log(
            `native anchor growth reached: ${path}, ${scale} command-created unrelated orders/Sessions; selected native paid anchor ready`,
          );
        },
        async warmup() {
          const measured = await capture(f.db, operation, { includeBackends: true });
          // Actual auto_explain plans include examined/removed rows and native buffers; backend IDs
          // accompany every statement and plan. No returned-row/LIMIT proxy or statement subtraction.
          console.log(JSON.stringify({ path, native: measured.capture, provider: f.requests }));
        },
        operation,
      });
      expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
      for (const sample of report.samples) {
        expect(sample.cost.statements).toBe(1);
        expect(sample.cost.rows).toBe(1);
        const native = Object.entries(sample.cost.relations).filter(
          ([name]) => /purchase_order/.test(name) && !name.startsWith('index:'),
        );
        expect(native.length).toBeGreaterThan(0);
        for (const [, cost] of native) expect(cost.sequentialScans).toBe(0);
        expect(sample.statementRepetitions.every((run) => run.length === 1)).toBe(true);
      }
      const after = await f.state(order);
      // Unrelated native commands intentionally advance the partition and the buyer's receipt history.
      expect({ order: after.order, events: after.events }).toEqual({ order: before.order, events: before.events });
      console.log(
        JSON.stringify({ path, report, boundary: 'native/adapter only; transport/composed/queue/retention pending' }),
      );
    } finally {
      await f.close();
    }
  });
}
