import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startMediaStack, type MediaStack } from './media-support.ts';

/** Production composeMain, PostgreSQL and native Jena; the proxy only observes
 * and slows the real transport so cancellation intersects nested hydration. */
test('composeMain closes nested public resource reads after cancellation and admits a fresh retry', async () => {
  const original = Bun.env.FUSEKI_URL;
  if (!original) throw new Error('Run through the isolated QA integration tier');
  const upstream = new URL(original);
  let observing = false, active = 0;
  const started: number[] = [];
  const allocations: number[] = [];
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const counted = observing;
    if (counted) {
      active++;
      started.push(performance.now());
      allocations.push(Number(request.headers.get('x-rezics-read-budget-ms')));
    }
    try {
      if (counted) await delay(20, undefined, { signal: request.signal });
      const destination = new URL(request.url);
      destination.protocol = upstream.protocol;
      destination.host = upstream.host;
      const response = await fetch(new Request(destination, request));
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (!request.signal.aborted) throw error;
      return new Response(null, { status: 499 });
    } finally { if (counted) active--; }
  } });
  let stack: MediaStack | undefined;
  const controller = new AbortController();
  try {
    const address = new URL(original);
    address.host = proxy.url.host;
    Bun.env.FUSEKI_URL = address.href;
    try { stack = await startMediaStack('request-read-budget'); }
    finally { Bun.env.FUSEKI_URL = original; }
    const author = await stack.member('request budget author');
    const visible = await stack.publicWork(author.actor);
    const hidden = await stack.privateWork(author.actor);
    const path = (work: string) => `/v1/resources/${work.split('/').at(-1)!}/page`;
    expect((await stack.call('GET', path(visible.work))).status).toBe(200);
    expect((await stack.call('GET', path(hidden.work))).status).toBe(404);

    observing = true;
    const pending = stack.main.handle(new Request(`http://main.local${path(visible.work)}`,
      { signal: controller.signal }));
    const settled = pending.catch(error => error);
    const admissionDeadline = performance.now() + 5000;
    while (started.length < 3 && performance.now() < admissionDeadline) await delay(5);
    expect(started.length).toBeGreaterThanOrEqual(3);
    const cancelledAt = performance.now();
    controller.abort();
    await Promise.race([settled, delay(1000).then(() => { throw new Error('Main cancellation did not settle'); })]);
    await delay(Math.max(0, cancelledAt + 100 - performance.now()));
    const atGrace = started.length;
    expect(active).toBe(0);
    await delay(300);
    expect(started).toHaveLength(atGrace);
    expect(started.filter(time => time > cancelledAt + 100)).toEqual([]);
    expect(active).toBe(0);
    expect(allocations.every(ms => ms > 0 && ms <= 10_000)).toBe(true);
    observing = false;
    const retry = await stack.call('GET', path(visible.work));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain(visible.title);
    const privateControl = await stack.call('GET', path(hidden.work));
    expect(privateControl.status).toBe(404);
    expect(await privateControl.text()).not.toContain(hidden.title);
  } finally {
    controller.abort();
    Bun.env.FUSEKI_URL = original;
    try { await stack?.stop(); }
    finally { await proxy.stop(true); }
  }
}, 120_000);
