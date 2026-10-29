import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKernelClient } from '@rezics/client';
import type { KernelClient } from '@rezics/client';
import { changePersonalLibraryEntry, removePersonalLibraryEntry } from '../src/library/entries-read';

const root = join(import.meta.dir, '..');
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const currentIncarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000100';
const key = '0192f3a0-6c1e-7b2a-9d4e-000000000022';

type Captured = { method: string; path: string; query: string; body?: unknown };

function kernel({ conflict = false }: { conflict?: boolean } = {}) {
  const calls: Captured[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === 'PUT' ? await request.clone().text() : '';
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: request.method, path: url.pathname, query: url.search, ...(body ? { body } : {}) });
      if (request.method === 'GET')
        return Response.json({
          libraryEntry: {
            subjectId,
            state: 'dropped',
            revision: 9,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
            incarnationId: currentIncarnationId,
            subject: { id: subjectId, label: 'Current entry', type: 'book' },
          },
        });
      if (conflict)
        return Response.json(
          {
            type: 'https://rezics.com/problems/conflict',
            title: 'conflict',
            status: 409,
            code: 'conflict',
            retryable: false,
            effect_status: 'not_applied',
            request_id: '0192f3a0-6c1e-7b2a-9d4e-000000000023',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({
        libraryEntry: { subjectId, state: 'paused', revision: 5, updatedAt: '2026-05-01T00:00:00.000Z', incarnationId },
      });
    },
  }) as unknown as KernelClient;
  return { client, calls };
}

const request = () => new Request('https://site.test/en/library', { headers: { authorization: 'Bearer test' } });

test('guarded changes and removals send the incarnation beside the existing revision', async () => {
  const { client, calls } = kernel();
  await changePersonalLibraryEntry(
    client,
    request(),
    {},
    {
      subjectId,
      state: 'paused',
      revision: 4,
      incarnationId,
      idempotencyKey: key,
    },
  );
  await removePersonalLibraryEntry(
    client,
    request(),
    {},
    {
      subjectId,
      revision: 4,
      incarnationId,
      idempotencyKey: key,
    },
  );
  expect(calls).toEqual([
    {
      method: 'PUT',
      path: `/v1/libraryEntries/${subjectId}`,
      query: '',
      body: { state: 'paused', revision: 4, incarnationId },
    },
    {
      method: 'DELETE',
      path: `/v1/libraryEntries/${subjectId}`,
      query: `?revision=4&incarnationId=${incarnationId}`,
    },
  ]);
});

test('legacy null and absent incarnations preserve the base request shape', async () => {
  const { client, calls } = kernel();
  await changePersonalLibraryEntry(
    client,
    request(),
    {},
    {
      subjectId,
      state: 'paused',
      revision: 4,
      incarnationId: null,
      idempotencyKey: key,
    },
  );
  await removePersonalLibraryEntry(
    client,
    request(),
    {},
    {
      subjectId,
      revision: 4,
      idempotencyKey: key,
    },
  );
  expect(calls).toEqual([
    {
      method: 'PUT',
      path: `/v1/libraryEntries/${subjectId}`,
      query: '',
      body: { state: 'paused', revision: 4 },
    },
    {
      method: 'DELETE',
      path: `/v1/libraryEntries/${subjectId}`,
      query: '?revision=4',
    },
  ]);
});

test('a stale incarnation reloads and returns the current entry without retrying either write', async () => {
  for (const action of ['change', 'remove'] as const) {
    const { client, calls } = kernel({ conflict: true });
    const result =
      action === 'change'
        ? await changePersonalLibraryEntry(
            client,
            request(),
            {},
            {
              subjectId,
              state: 'paused',
              revision: 4,
              incarnationId,
              idempotencyKey: key,
            },
          )
        : await removePersonalLibraryEntry(
            client,
            request(),
            {},
            {
              subjectId,
              revision: 4,
              incarnationId,
              idempotencyKey: key,
            },
          );
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      entry: { subjectId, state: 'dropped', revision: 9, incarnationId: currentIncarnationId },
    });
    expect(calls.map((call) => call.method)).toEqual([action === 'change' ? 'PUT' : 'DELETE', 'GET']);
  }
});

test('no-JavaScript entry forms preserve the incarnation through their server action', async () => {
  const view = await readFile(join(root, 'src/library/subject-slot-view.tsx'), 'utf8');
  const actions = await readFile(join(root, 'src/library/subject-slot-mutation.ts'), 'utf8');
  expect(view).toMatch(/<input[^>]*type=["']hidden["'][^>]*name=["']incarnationId["']/);
  expect(actions).toMatch(/incarnationId/);
});

test('entry writes stay centralized in entries-read.ts', async () => {
  const sources = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: join(root, 'src') })].filter(
    (file) => file !== 'library/entries-read.ts',
  );
  const violations = await Promise.all(
    sources.map(async (file) => {
      const source = await readFile(join(root, 'src', file), 'utf8');
      return /libraryEntries\([^\n]*\)\s*\.(?:put|delete)/.test(source) ? file : null;
    }),
  );
  expect(violations.filter(Boolean)).toEqual([]);
});

test('the story fake accepts omitted guards and refuses stale incarnations without changing its entry', async () => {
  const { createRecordedKernelFetch } = await import('../src/kernel/fake');
  const fetch = createRecordedKernelFetch({});
  const url = `https://kernel.test/v1/libraryEntries/${subjectId}`;
  const before = await (await fetch(url)).json();
  for (const method of ['PUT', 'DELETE']) {
    const stale = await fetch(method === 'DELETE' ? `${url}?revision=1&incarnationId=${currentIncarnationId}` : url, {
      method,
      ...(method === 'PUT'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: 'paused', revision: 1, incarnationId: currentIncarnationId }),
          }
        : {}),
    });
    expect(stale.status).toBe(409);
    expect(await (await fetch(url)).json()).toEqual(before);
    const legacy = await fetch(method === 'DELETE' ? `${url}?revision=1` : url, {
      method,
      ...(method === 'PUT'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'paused', revision: 1 }) }
        : {}),
    });
    expect(legacy.status).toBe(method === 'PUT' ? 200 : 204);
  }
});
