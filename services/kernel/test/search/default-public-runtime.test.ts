import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSearchDriver } from './outcome-driver.ts';
import type { SearchDriver, HttpResponse } from '../../../../specs/search-driver.ts';

async function currentPage(driver: SearchDriver, body: Record<string, unknown>): Promise<HttpResponse> {
  const deadline = Date.now() + 60_000;
  do {
    const response = await driver.request('anonymous', 'POST', '/v1/subjects:search', body);
    if (response.status === 200) return response;
    expect(response.status).toBe(503);
    expect(response.body.code).toMatch(/^(index_not_ready|semantic_not_ready)$/);
    expect(response.headers.get('retry-after')).toBeTruthy();
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error('The default public Search journey did not finish finite preparation within 60 seconds');
}
function subjects(
  response: HttpResponse,
): (Record<string, unknown> & { id: string; summary: unknown; base: unknown })[] {
  expect(response.status).toBe(200);
  expect(response.body).not.toHaveProperty('total');
  expect(response.body).not.toHaveProperty('observation');
  expect(response.body).not.toHaveProperty('execution');
  expect(response.body).not.toHaveProperty('job');
  if (!Array.isArray(response.body.subjects)) throw new Error('Search omitted its subjects');
  return response.body.subjects;
}

async function currentSuggestions(driver: SearchDriver, query: string): Promise<HttpResponse> {
  const deadline = Date.now() + 60_000;
  do {
    const response = await driver.request('anonymous', 'GET', `/v1/subjects:suggest?q=${encodeURIComponent(query)}`);
    if (response.status === 200) return response;
    expect(response.status).toBe(503);
    expect(response.body.code).toMatch(/^(index_not_ready|semantic_not_ready)$/);
    expect(response.headers.get('retry-after')).toBeTruthy();
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error('The default public suggestion journey did not finish finite preparation within 60 seconds');
}

test('the default real Search journey provides useful current-authorized filled or exhausted pages with finite actual preparation and recovery', async () => {
  const driver = await createSearchDriver();
  const marker = `publicjourney${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
  const removed: string[] = [];
  const kept: string[] = [];
  try {
    for (let n = 0; n < 23; n++) {
      const response = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: `${marker} ${n < 20 ? 'a' : 'z'}${String(n).padStart(2, '0')}` },
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(response.status).toBe(201);
      const subject = response.body.subject as { id: string };
      (n < 20 ? removed : kept).push(subject.id);
    }
    const initial = subjects(await currentPage(driver, { text: marker, sort: 'name', limit: 100 }));
    expect(new Set(initial.map((hit) => hit.id))).toEqual(new Set([...removed, ...kept]));
    await driver.indexing('paused');
    for (const id of removed) await driver.remove(id, 'hidden');
    const lagged = await driver.request('anonymous', 'POST', '/v1/subjects:search', {
      text: marker,
      sort: 'name',
      limit: 2,
    });
    if (lagged.status === 200) {
      const hits = subjects(lagged);
      expect(hits.every((hit) => kept.includes(hit.id))).toBe(true);
      expect(hits.length === 2 || lagged.body.next === null).toBe(true);
    } else {
      expect(lagged.status).toBe(503);
      expect(lagged.body.code).toBe('index_not_ready');
    }
    await driver.indexing('running');
    const first = await currentPage(driver, { text: marker, sort: 'name', limit: 2 });
    const firstHits = subjects(first);
    expect(firstHits).toHaveLength(2);
    for (const hit of firstHits) {
      expect(kept).toContain(hit.id);
      expect(hit.summary).not.toBeNull();
      expect(hit.base).toBeDefined();
    }
    expect(typeof first.body.next).toBe('string');
    const last = await currentPage(driver, { text: marker, sort: 'name', limit: 2, cursor: first.body.next });
    expect(subjects(last)).toHaveLength(1);
    expect(last.body.next).toBeNull();
    expect(new Set([...firstHits, ...subjects(last)].map((hit) => hit.id))).toEqual(new Set(kept));
    await driver.rebuild();
    const stale = await driver.request('anonymous', 'POST', '/v1/subjects:search', {
      text: marker,
      sort: 'name',
      limit: 2,
      cursor: first.body.next,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('search_restart_required');
    expect(subjects(await currentPage(driver, { text: marker, sort: 'name', limit: 2 }))).toHaveLength(2);
  } finally {
    await driver.close();
  }
}, 900_000);

test('the default prefix journey hydrates current suggestions and recovers after privacy repair', async () => {
  const driver = await createSearchDriver();
  const marker = `suggestjourney${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
  try {
    const created = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: `${marker} encyclopedia` },
      },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(created.status).toBe(201);
    const id = (created.body.subject as { id: string }).id;
    async function suggestions(): Promise<HttpResponse> {
      const deadline = Date.now() + 60_000;
      do {
        const page = await driver.request('anonymous', 'GET', `/v1/subjects:suggest?q=${marker}%20encyclop`);
        if (page.status === 200) return page;
        expect(page.status).toBe(503);
        expect(page.body.code).toMatch(/^(index_not_ready|semantic_not_ready)$/);
        expect(page.headers.get('retry-after')).toBeTruthy();
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      throw new Error('Default native prefix preparation did not finish');
    }
    const first = await suggestions();
    const hits = subjects(first);
    expect(hits.map((hit) => hit.id)).toContain(id);
    expect(hits.find((hit) => hit.id === id)!.summary).not.toBeNull();
    await driver.indexing('paused');
    await driver.remove(id, 'hidden');
    const delayed = await driver.request('anonymous', 'GET', `/v1/subjects:suggest?q=${marker}%20encyclop`);
    if (delayed.status === 200) expect(subjects(delayed).map((hit) => hit.id)).not.toContain(id);
    else {
      expect(delayed.status).toBe(503);
      expect(delayed.body.code).toBe('index_not_ready');
    }
    await driver.indexing('running');
    expect(subjects(await suggestions()).map((hit) => hit.id)).not.toContain(id);
  } finally {
    await driver.close();
  }
}, 900_000);

test('the default real Search and Suggest recheck corrected native terms while indexing is paused', async () => {
  const driver = await createSearchDriver();
  const suffix = randomUUID().replaceAll('-', '');
  const marker = `termjourney${suffix}`;
  const oldAlias = `oldalias${suffix}`;
  const newAlias = `newalias${suffix}`;
  try {
    const changed = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: `${marker} before` },
        aliases: { en: [oldAlias] },
        descriptions: { en: `${marker} old description` },
      },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(changed.status).toBe(201);
    const changedId = (changed.body.subject as { id: string }).id;
    const safe = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: `${oldAlias} independent` } },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(safe.status).toBe(201);
    const safeId = (safe.body.subject as { id: string }).id;
    const filter = { type: { in: ['schema:Book'] } };

    const initial = subjects(
      await currentPage(driver, { text: oldAlias, filter, sort: 'id', limit: 100 }),
    );
    expect(new Set(initial.map((hit) => hit.id))).toEqual(new Set([changedId, safeId]));
    expect(new Set(subjects(await currentSuggestions(driver, oldAlias)).map((hit) => hit.id))).toEqual(
      new Set([changedId, safeId]),
    );

    await driver.indexing('paused');
    const patch = await driver.request(
      'editor',
      'PATCH',
      `/v1/subjects/${changedId}/terms`,
      {
        labels: { en: `${marker} after` },
        aliases: { en: [newAlias] },
        descriptions: { en: `${marker} current description` },
      },
      {
        'Idempotency-Key': `"${randomUUID()}"`,
        'If-Match': '"1"',
      },
    );
    expect(patch.status).toBe(200);

    const duringLag = subjects(
      await currentPage(driver, { text: oldAlias, filter, sort: 'id', limit: 100 }),
    );
    expect(duringLag.map((hit) => hit.id)).toEqual([safeId]);
    expect(subjects(await currentSuggestions(driver, oldAlias)).map((hit) => hit.id)).toEqual([safeId]);

    const currentFields = subjects(
      await currentPage(driver, {
        text: marker,
        filter,
        sort: 'id',
        limit: 100,
        descriptions: true,
      }),
    ).find((hit) => hit.id === changedId);
    expect(currentFields).toBeDefined();
    expect(currentFields?.labels).toEqual({ en: `${marker} after` });
    expect(currentFields?.descriptions).toEqual({ en: `${marker} current description` });
    const evidence = JSON.stringify(currentFields!.matchEvidence);
    expect(evidence).not.toContain('before');
    expect(evidence).not.toContain(oldAlias);

    await driver.indexing('running');
    expect(
      subjects(await currentPage(driver, { text: newAlias, filter, sort: 'id', limit: 100 })).map((hit) => hit.id),
    ).toContain(changedId);
    expect(subjects(await currentSuggestions(driver, newAlias)).map((hit) => hit.id)).toContain(changedId);
  } finally {
    await driver.close();
  }
}, 900_000);
