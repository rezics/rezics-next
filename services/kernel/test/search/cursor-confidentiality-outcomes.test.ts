import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, SearchDriver } from '../../../../specs/search-driver.ts';
import { createSearchDriver } from './outcome-driver.ts';

function ids(response: HttpResponse): string[] {
  expect(response.status).toBe(200);
  return (response.body.subjects as { id: string }[]).map(({ id }) => id);
}

async function create(driver: SearchDriver, label: string): Promise<string> {
  const response = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: label }, statements: {} },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(response.status, `Real Semantic create failed: ${JSON.stringify(response.body)}`).toBe(201);
  return (response.body.subject as { id: string }).id;
}

async function indexed(driver: SearchDriver, marker: string, expected: string[]) {
  const deadline = performance.now() + 30_000;
  let last: HttpResponse | undefined;
  do {
    last = await driver.request('anonymous', 'POST', '/v1/subjects:search', { text: marker, sort: 'name', limit: 20 });
    if (last.status === 200 && JSON.stringify(ids(last)) === JSON.stringify(expected)) return;
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Real default-worker indexing did not converge: ${JSON.stringify(last?.body)}`);
}

for (const mode of ['hidden', 'taken_down'] as const) {
  test(`real API cursor confidentiality after a rejected ${mode} lookahead`, async () => {
    // Uses original personas, real Auth, default worker and OpenSearch, including their failures.
    const driver = await createSearchDriver();
    try {
      const marker = `cursor${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'x')}`;
      const secretName = `b ${marker} withheldsecretnormalizedname`;
      const a = await create(driver, `a ${marker} visiblefirst`);
      const b = await create(driver, secretName);
      const c = await create(driver, `c ${marker} visiblelast`);
      await indexed(driver, marker, [a, b, c]);
      await driver.indexing('paused');
      await driver.remove(b, mode); // Await the production visibility commit, leaving the index stale.

      const request = { text: marker, sort: 'name', limit: 1 };
      const first = await driver.request('anonymous', 'POST', '/v1/subjects:search', request);
      expect(ids(first)).toEqual([a]);
      expect(JSON.stringify(first.body.subjects)).not.toContain(b);
      expect(JSON.stringify(first.body.subjects)).not.toContain(secretName);
      const token = first.body.next;
      expect(token).toBeString();
      expect(typeof token === 'string' && token.length > 0).toBe(true);
      if (typeof token !== 'string') throw new Error('Expected an actual continuation token');

      // A is emitted, rejected B is consumed, and accepted C remains unconsumed lookahead.
      // Resume pagination while indexing stays paused so index deletion cannot mask a lost position.
      const second = await driver.request('anonymous', 'POST', '/v1/subjects:search', { ...request, cursor: token });
      expect(ids(second)).toEqual([c]);
      expect(second.body.next).toBeNull();
      expect([...ids(first), ...ids(second)]).toEqual([a, c]);

      // The attacker sees only the wire token: no signing keys or backend decode.
      const views = [token, ...token.split('.').map((part) => Buffer.from(part, 'base64url').toString('utf8'))];
      expect([b, secretName].filter((secret) => views.some((view) => view.includes(secret)))).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 600_000);
}
