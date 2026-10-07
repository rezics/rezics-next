import { expect, test } from 'bun:test';
import { SeedApi, type SeedEndpoints } from './api.ts';

const uuid = '00000000-0000-4000-a000-000000000001';
const native = `https://rezics.com/id/${uuid}`;
const identity = { profile: 'realm-reply-identity-v1', reply: native,
  variantId: `urn:rezics:variant:${uuid}`, revisionId: uuid, author: native,
  rootTarget: native, rootRevision: native, parentReply: null, parentRevision: null, contextRevision: null };
const draft = { profile: 'member-reply-draft-v1', reply: native,
  variantId: `urn:rezics:variant:${uuid}`, rootTarget: native, rootRevision: native,
  language: 'en', direction: 'ltr', expectedHead: null, body: 'A reply', actingSubject: native };

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
    const body = identity;
    expect(await api.post<{ revisionId: string }>('/v1/realm-replies', body, 'token', 'seed-key'))
      .toEqual({ revisionId: 'saved' });
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ key: 'seed-key', body })));
  });
});

test('G-543: a cancelled reply-draft read admission gets a fresh attempt while pending replay keeps that attempt', async () => {
  await fixture(['read_basis_changed', 'pending', 'saved'], async (api, calls) => {
    const body = draft;
    expect(await api.post<{ revisionId: string }>('/v1/member-reply-drafts', body, 'token', 'seed-key'))
      .toEqual({ revisionId: 'saved' });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.key).toBe('seed-key');
    expect(calls[1]!.key).not.toBe('seed-key');
    expect(calls[2]!.key).toBe(calls[1]!.key);
    expect(calls.every(call => JSON.stringify(call.body) === JSON.stringify(body))).toBe(true);
  });
});

test('G-909: seed never retries an unrelated PUT conflict', async () => {
  await fixture(['alias_conflict'], async (api, calls) => {
    await expect(api.put(`/v1/works/${uuid}/reader-status`, {
      actingSubject: native, expectedVersion: 0, status: 'reading',
    }, 'token', 'seed-key')).rejects.toThrow('HTTP 409');
    expect(calls).toHaveLength(1);
  });
});

test('G-543: seed moving-read write retries remain bounded', async () => {
  await fixture(['read_basis_changed'], async (api, calls) => {
    await expect(api.post('/v1/realm-replies', identity, 'token', 'seed-key')).rejects.toThrow('HTTP 409');
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map(call => call.key))).toEqual(new Set(['seed-key']));
  });
}, 10_000);

test('a closed call without a platform administrator names the group and still reaches Main', async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    calls += 1;
    return Response.json({ code: 'platform_closed', title: 'This capability is closed' }, { status: 403 });
  } });
  try {
    const api = new SeedApi({ main: server.url.origin } as SeedEndpoints);
    const error = await api.get(`/v1/themes/${uuid}/first-party`, 'token').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('platform:executable-themes');
    expect((error as Error).message).toContain('platform_closed');
    expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test('a public call keeps a platform_closed body, and another 403 is left unchanged', async () => {
  const bodies = [
    { code: 'platform_closed', title: 'This capability is closed' },
    { code: 'forbidden', title: 'No' },
  ];
  let index = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    const body = bodies[index]!;
    index += 1;
    return Response.json(body, { status: 403 });
  } });
  try {
    const api = new SeedApi({ main: server.url.origin } as SeedEndpoints);
    await expect(api.get('/v1/works', 'token')).rejects.toThrow(JSON.stringify(bodies[0]));
    const denied = await api.get(`/v1/themes/${uuid}/first-party`, 'token')
      .then(() => null, (caught: unknown) => caught);
    expect((denied as Error).message).toContain('"code":"forbidden"');
    expect((denied as Error).message).not.toContain('platform:executable-themes');
  } finally { await server.stop(true); }
});
