import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SearchDriver } from '../../../../specs/search-driver.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { createSearchDriver } from './outcome-driver.ts';

type Page = { subjects: { id: string }[]; next: string | null };

function useful(response: HttpResponse, limit: number): Page | undefined {
  if (response.status === 503) {
    expect(response.body.code).toBe('index_not_ready');
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(response.body).not.toHaveProperty('next');
    expect(response.body).not.toHaveProperty('subjects');
    return;
  }
  expect(response.status).toBe(200);
  const body = response.body;
  expect(Array.isArray(body.subjects)).toBe(true);
  const subjects = body.subjects as Page['subjects'];
  expect(subjects.length).toBeLessThanOrEqual(limit);
  if (subjects.length < limit) expect(body.next).toBeNull();
  expect(body).not.toHaveProperty('count');
  expect(body).not.toHaveProperty('total');
  expect(body).not.toHaveProperty('job');
  expect(body).not.toHaveProperty('observation');
  expect(body.next === null || typeof body.next === 'string').toBe(true);
  return { subjects, next: body.next as Page['next'] };
}

async function ready(driver: SearchDriver, request: Record<string, unknown>, expected: readonly string[]) {
  const deadline = performance.now() + 60_000;
  do {
    const response = await driver.request('anonymous', 'POST', '/v1/subjects:search', request);
    const page = useful(response, Number(request.limit));
    if (page && expected.every((id) => page.subjects.some((subject) => subject.id === id))) return page;
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error('Finite native Search input did not produce a useful current page');
}

test('the default real Search journey provides useful current-authorized filled or exhausted pages with finite actual preparation and recovery', async () => {
  const driver = await createSearchDriver();
  try {
    const marker = `useful${randomUUID()
      .replaceAll('-', '')
      .replace(/[0-9]/g, (n) => String.fromCharCode(97 + Number(n)))}`;
    const ids: string[] = [];
    for (let index = 0; index < 27; index++) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: `${marker} ${String(index).padStart(2, '0')}` },
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(created.status).toBe(201);
      const subject = created.body.subject as { id: string };
      expect(typeof subject.id).toBe('string');
      ids.push(subject.id);
    }
    const request = { text: marker, sort: 'name', limit: 100 };
    await ready(driver, request, ids);
    await driver.indexing('paused');
    for (const id of ids.slice(0, 24)) await driver.remove(id, 'hidden');
    const sparse = useful(
      await driver.request('anonymous', 'POST', '/v1/subjects:search', {
        ...request,
        limit: 1,
      }),
      1,
    );
    if (sparse) expect(sparse.subjects.map(({ id }) => id)).toEqual([ids[24]!]);
    await driver.indexing('running');
    const first = await ready(driver, { ...request, limit: 1 }, [ids[24]!]);
    expect(typeof first.next).toBe('string');
    const continuation = { ...request, limit: 1, cursor: first.next };
    await driver.searchNode('down');
    useful(await driver.request('anonymous', 'POST', '/v1/subjects:search', continuation), 1);
    await driver.searchNode('up');
    const second = await ready(driver, continuation, [ids[25]!]);
    expect(second.subjects.map(({ id }) => id)).toEqual([ids[25]!]);
    const last = await ready(driver, { ...request, limit: 10 }, ids.slice(24));
    expect(last.subjects.map(({ id }) => id)).toEqual(ids.slice(24));
    expect(last.next).toBeNull();
    const empty = useful(
      await driver.request('anonymous', 'POST', '/v1/subjects:search', {
        text: `${marker}nomatches`,
        sort: 'name',
        limit: 1,
      }),
      1,
    );
    expect(empty).toEqual({ subjects: [], next: null });
  } finally {
    await driver.close();
  }
}, 180_000);
