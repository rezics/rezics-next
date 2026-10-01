import { expect, test } from 'bun:test';
import { SeedApi, type SeedEndpoints } from './api.ts';

const uuid = '00000000-0000-4000-a000-000000000001';
const id = `https://rezics.com/id/${uuid}`;
const revision = (n: number) => `https://rezics.com/id/00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const path = `/v1/works/${uuid}/releases/${uuid}`;
const release = { profile: 'release-v1', expectedHead: null, actingSubject: id, id,
  kind: 'formal', status: 'official', contentLanguages: ['en'], isTranslation: true,
  originalLanguages: ['zh'], titleLanguage: 'en', tracklistLanguage: null,
  title: { value: 'The Story of the Stone', language: 'en' }, editionStatement: null,
  publisher: 'Penguin', publicationYear: 1973, isbn13: null,
  originalUrl: null, fixedRelease: null, coverage: null, evidence: null };
type Call = { method: string; key: string | null; body?: Record<string, unknown> };
async function serverFixture(handler: (request: Request, call: Call, calls: Call[]) => Response | Promise<Response>,
  operation: (api: SeedApi, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const call = { method: request.method, key: request.headers.get('idempotency-key'),
      ...(request.method === 'GET' ? {} : { body: await request.json() as Record<string, unknown> }) };
    calls.push(call);
    return handler(request, call, calls);
  } });
  try {
    const api = new SeedApi({ main: server.url.origin,
      writeCounts: { written: 0, replayed: 0, reconciled: 0, lookups: 0 } } as SeedEndpoints);
    await operation(api, calls);
  } finally { await server.stop(true); }
}
const conflict = (code: string) => Response.json({ code }, { status: 409 });
const view = (body: Record<string, unknown>, head: string) => ({ ...body, profile: 'release-v2',
  revision: head, coverage: [], legacyCoverage: body.coverage });

test('G-909: an older release converges once, then its original-key replay has zero writes', async () => {
  let current = { ...release, isTranslation: false, originalLanguages: [] as string[] };
  let head = revision(2);
  let writes = 0;
  const receipts = new Map<string, { body: unknown; result: unknown }>();
  // The old key belongs to the old plan, not to the new release body.
  receipts.set('seed-release', { body: current, result: { release: id, revision: head, replayed: true } });
  await serverFixture((_request, call) => {
    if (call.method === 'GET') return Response.json(view(current, head));
    const receipt = receipts.get(call.key!);
    if (receipt) return JSON.stringify(receipt.body) !== JSON.stringify(call.body)
      ? conflict('idempotency_conflict') : Response.json(receipt.result);
    if (call.body!.expectedHead !== head) return conflict('release_basis_changed');
    current = call.body! as typeof current;
    head = revision(3);
    writes++;
    const result = { work: id, release: id, revision: head, replayed: false };
    receipts.set(call.key!, { body: call.body, result: { ...result, replayed: true } });
    return Response.json(result);
  }, async (api, calls) => {
    const result = await api.put<{ revision: string }>(path, release, 'token', 'seed-release');
    expect(result.revision).toBe(revision(3));
    expect(writes).toBe(1);
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET', 'PUT']);
    const retry = calls[2]!;
    expect(retry.body).toEqual({ ...release, expectedHead: revision(2) });
    expect(retry.key).not.toBe('seed-release');
    expect(await api.put(path, release, 'token', 'seed-release')).toMatchObject({ release: id, revision: revision(3), replayed: true });
    expect(writes).toBe(1);
    expect(calls.slice(3).map(call => call.method)).toEqual(['PUT', 'GET']);
    expect(api.endpoints.writeCounts).toEqual({ written: 1, replayed: 0, reconciled: 1, lookups: 0 });
    expect(release.expectedHead).toBeNull();
  });
});

test('G-909: concurrent basis movement refreshes again; a pending retry keeps the refreshed key and body', async () => {
  let head = revision(2), reads = 0, writes = 0;
  await serverFixture((_request, call) => {
    if (call.method === 'GET') { reads++; return Response.json(view({ ...release, publisher: 'Old' }, head)); }
    writes++;
    if (writes === 1) return conflict('release_basis_changed');
    if (writes === 2) { head = revision(3); return conflict('release_basis_changed'); }
    if (writes === 3) return Response.json({ code: 'pending' }, { status: 202 });
    return Response.json({ release: id, revision: revision(4), replayed: true });
  }, async (api, calls) => {
    expect(await api.put(path, release, 'token', 'x'.repeat(128))).toMatchObject({ revision: revision(4) });
    expect(reads).toBe(2);
    const puts = calls.filter(call => call.method === 'PUT');
    expect(puts[1]!.key).not.toBe(puts[2]!.key);
    expect(puts[2]).toEqual(puts[3]);
    expect(puts[2]!.body!.expectedHead).toBe(revision(3));
    expect(puts.every(call => /^[A-Za-z0-9:_./-]{1,128}$/.test(call.key!))).toBe(true);
    expect(api.endpoints.writeCounts?.written).toBe(0);
  });
});

test('G-909: PUT basis retries remain bounded when another writer never settles', async () => {
  let reads = 0;
  await serverFixture((_request, call) => call.method === 'GET'
    ? Response.json(view({ ...release, publisher: 'Old' }, revision(++reads + 1)))
    : conflict('release_basis_changed'), async (api, calls) => {
    await expect(api.put(path, release, 'token', 'seed-release')).rejects.toThrow('HTTP 409');
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(8);
    expect(reads).toBe(7);
  });
});

test('G-909: POST body and basis conflicts never change keys or create another record', async () => {
  for (const code of ['idempotency_conflict', 'release_basis_changed', 'stale_head']) {
    await serverFixture(() => conflict(code), async (api, calls) => {
      await expect(api.post('/v1/works', { profile: 'metadata-only-v1', title: 'Book',
        semanticTypes: ['https://schema.org/Book'], language: 'en', actingSubject: id, authoring: 'own-work',
      }, 'token', 'seed-create')).rejects.toThrow(code);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.key).toBe('seed-create');
    });
  }
});

test('G-909: an old catalogue creation conflict remains actionable instead of minting a new Work', async () => {
  await serverFixture(() => conflict('idempotency_conflict'), async (api, calls) => {
    await expect(api.post('/v1/works', { profile: 'metadata-only-v1', title: 'Catalogue Work',
      language: 'ja', semanticTypes: ['https://schema.org/Book'], actingSubject: id,
      grain: 'new-creative-scope', candidateReceipt: uuid,
    }, 'token', 'seed-catalogue')).rejects.toThrow('idempotency_conflict');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe('seed-catalogue');
  });
});

test('G-909: denied, missing or unavailable refreshes fail without sending a new PUT', async () => {
  for (const status of [403, 404, 503]) await serverFixture((_request, call) => call.method === 'GET'
    ? Response.json({ code: 'release_unavailable' }, { status }) : conflict('release_basis_changed'), async (api, calls) => {
    await expect(api.put(path, release, 'token', 'seed-release')).rejects.toThrow(`HTTP ${status}`);
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET']);
  });
});

test('G-909: an unreadable legacy release cannot be skipped or updated without its basis', async () => {
  let puts = 0;
  await serverFixture((_request, call) => call.method === 'GET'
    ? Response.json({ code: 'work_unavailable' }, { status: 404 })
    : conflict(++puts === 1 ? 'idempotency_conflict' : 'release_basis_changed'), async (api, calls) => {
    await expect(api.put(path, release, 'token', 'seed-release')).rejects.toThrow('HTTP 404');
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET', 'PUT', 'GET']);
    const writes = calls.filter(call => call.method === 'PUT');
    expect(writes[1]!.body).toEqual(release);
    expect(writes[1]!.key).not.toBe(writes[0]!.key);
    expect(api.endpoints.writeCounts).toEqual({ written: 0, replayed: 0, reconciled: 0, lookups: 0 });
  });
});

test('G-909: catalogue lookup waits for projection readiness without changing its body or key', async () => {
  const body = { profile: 'catalogue-candidates-v1', originalTitle: { value: 'Book', language: 'en' },
    aliases: [], romanizations: [], creators: [], dates: [], identifiers: [] };
  await serverFixture((_request, _call, calls) => calls.length <= 2
    ? Response.json({ code: calls.length === 1 ? 'search_index_unavailable' : 'catalogue_unavailable' }, { status: 503 })
    : Response.json({ candidateReceipt: uuid, candidates: [] }), async (api, calls) => {
    expect(await api.post('/v1/catalogue/candidates', body, 'token', 'seed-search')).toMatchObject({ candidateReceipt: uuid });
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.key === 'seed-search' && JSON.stringify(call.body) === JSON.stringify(body))).toBe(true);
    expect(api.endpoints.writeCounts).toEqual({ written: 0, replayed: 0, reconciled: 0, lookups: 1 });
  });
});

test('G-909: classification-resolution POSTs are reads in the seed write report', async () => {
  await serverFixture(() => Response.json({ state: 'accepted' }), async api => {
    await api.post('/v1/classification-resolutions', { profile: 'classification-resolution-v1',
      context: { kind: 'global' }, work: id, mainVersion: id, sense: id }, 'token', 'seed-resolution');
    expect(api.endpoints.writeCounts).toEqual({ written: 0, replayed: 0, reconciled: 0, lookups: 1 });
  });
});

test('G-909: a lost POST response retries the exact creation key and body', async () => {
  const requests: RequestInit[] = [];
  const api = new SeedApi({ main: 'http://main.test', writeCounts: {
    written: 0, replayed: 0, reconciled: 0, lookups: 0 } } as SeedEndpoints, async (_url, init) => {
    requests.push(init!);
    if (requests.length === 1) throw new TypeError('The socket connection was closed unexpectedly');
    return Response.json({ work: id, replayed: true });
  });
  await expect(api.post('/v1/works', { profile: 'metadata-only-v1', title: 'Book',
    semanticTypes: ['https://schema.org/Book'], language: 'en', actingSubject: id, authoring: 'own-work',
  }, 'token', 'seed-create')).resolves.toMatchObject({ work: id, replayed: true });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(new Headers(requests[1]!.headers).get('idempotency-key')).toBe('seed-create');
  expect(api.endpoints.writeCounts).toEqual({ written: 0, replayed: 1, reconciled: 0, lookups: 0 });
});

test('G-909: a lost refresh response retries the read before changing the PUT body', async () => {
  const methods: string[] = [];
  const api = new SeedApi({ main: 'http://main.test' } as SeedEndpoints, async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    if (methods.length === 1) return conflict('release_basis_changed');
    if (methods.length === 2) throw new TypeError('The socket connection was closed unexpectedly');
    return Response.json(view(release, revision(2)));
  });
  await expect(api.put(path, release, 'token', 'seed-release')).resolves.toMatchObject({ replayed: true });
  expect(methods).toEqual(['PUT', 'GET', 'GET']);
});

test('G-909: network retries stop at the write budget and identify the failing Main path', async () => {
  let requests = 0;
  const api = new SeedApi({ main: 'http://main.test' } as SeedEndpoints, async () => {
    requests++;
    throw new TypeError('closed');
  });
  await expect(api.put(path, release, 'token', 'seed-release')).rejects.toThrow(`Main ${path}: transport failed after retries`);
  expect(requests).toBe(8);
}, 10_000);

test('G-909: legacy omitted-language Space creation replays with English and its original key', async () => {
  const body = { profile: 'space-realm-v1', name: 'Books', capabilities: ['realm'], actingSubject: id };
  await serverFixture((_request, call) => call.body!.language === 'en'
    ? Response.json({ space: id, realm: id, replayed: true }) : conflict('idempotency_conflict'), async (api, calls) => {
    await expect(api.post('/v1/spaces', body, 'token', 'seed-space')).resolves.toMatchObject({ replayed: true });
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.key)).toEqual(['seed-space', 'seed-space']);
    expect(calls[1]!.body).toEqual({ ...body, language: 'en' });
    expect(body).not.toHaveProperty('language');
    expect(api.endpoints.writeCounts?.written).toBe(0);
  });
});

test('G-909: explicitly declared Space languages are never replaced on a creation conflict', async () => {
  await serverFixture(() => conflict('idempotency_conflict'), async (api, calls) => {
    await expect(api.post('/v1/spaces', { profile: 'space-realm-v1', name: '书籍', language: 'zh-Hans',
      capabilities: ['realm'], actingSubject: id }, 'token', 'seed-space')).rejects.toThrow('idempotency_conflict');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body!.language).toBe('zh-Hans');
  });
});
