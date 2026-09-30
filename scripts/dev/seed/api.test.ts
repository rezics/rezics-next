import { expect, test } from 'bun:test';
import { SeedApi, type SeedEndpoints } from './api.ts';

async function fixture(codes: string[], operation: (api: SeedApi, calls: { key: string; body: unknown }[]) => Promise<void>) {
  const calls: { key: string; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    calls.push({ key: request.headers.get('idempotency-key')!, body: await request.json() });
    const code = codes[Math.min(calls.length - 1, codes.length - 1)]!;
    return Response.json(code === 'saved' ? { revisionId: 'saved' } : { code },
      { status: code === 'saved' ? 201 : code === 'pending' ? 202 : 409 });
  } });
  try {
    await operation(new SeedApi({ main: server.url.origin } as SeedEndpoints), calls);
  } finally { await server.stop(true); }
}

test('G-543: seed retries a moving admission read and pending write with the original key and input', async () => {
  await fixture(['read_basis_changed', 'pending', 'saved'], async (api, calls) => {
    const body = { actingSubject: 'writer', expectedHead: null };
    expect(await api.post<{ revisionId: string }>('/v1/realm-replies', body, 'token', 'seed-key'))
      .toEqual({ revisionId: 'saved' });
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ key: 'seed-key', body })));
  });
});

test('G-543: a cancelled reply-draft read admission gets a fresh attempt while pending replay keeps that attempt', async () => {
  await fixture(['read_basis_changed', 'pending', 'saved'], async (api, calls) => {
    const body = { actingSubject: 'writer', expectedHead: null };
    expect(await api.post<{ revisionId: string }>('/v1/member-reply-drafts', body, 'token', 'seed-key'))
      .toEqual({ revisionId: 'saved' });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.key).toBe('seed-key');
    expect(calls[1]!.key).not.toBe('seed-key');
    expect(calls[2]!.key).toBe(calls[1]!.key);
    expect(calls.every(call => JSON.stringify(call.body) === JSON.stringify(body))).toBe(true);
  });
});

test('G-543: seed never retries an optimistic head conflict', async () => {
  await fixture(['head_conflict'], async (api, calls) => {
    await expect(api.put('/v1/works/work', {}, 'token', 'seed-key')).rejects.toThrow('HTTP 409');
    expect(calls).toHaveLength(1);
  });
});

test('G-543: seed moving-read write retries remain bounded', async () => {
  await fixture(['read_basis_changed'], async (api, calls) => {
    await expect(api.post('/v1/realm-replies', {}, 'token', 'seed-key')).rejects.toThrow('HTTP 409');
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map(call => call.key))).toEqual(new Set(['seed-key']));
  });
}, 10_000);
