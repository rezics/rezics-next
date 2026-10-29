import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KernelClient } from '@rezics/client';
import { changePersonalLibraryEntry, removePersonalLibraryEntry } from '../src/library/entries-read';

const root = join(import.meta.dir, '..');
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const currentIncarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000100';
const key = '0192f3a0-6c1e-7b2a-9d4e-000000000022';

type Captured = { method: string; body?: unknown; options?: unknown };

function kernel({ conflict = false }: { conflict?: boolean } = {}) {
  const calls: Captured[] = [];
  const client = {
    libraryEntries: (params: { subjectId: string }) => ({
      put: async (body: unknown, options: unknown) => {
        calls.push({ method: 'PUT', body, options });
        if (conflict) return { status: 409, error: { status: 409, value: { code: 'conflict' } } };
        return {
          status: 200,
          data: {
            libraryEntry: {
              subjectId: params.subjectId,
              state: 'paused',
              revision: 5,
              updatedAt: '2026-05-01T00:00:00.000Z',
              incarnationId,
            },
          },
        };
      },
      delete: async (body: unknown, options: unknown) => {
        calls.push({ method: 'DELETE', body, options });
        if (conflict) return { status: 409, error: { status: 409, value: { code: 'conflict' } } };
        return { status: 204 };
      },
      get: async () => ({
        status: 200,
        data: {
          libraryEntry: {
            subjectId: params.subjectId,
            state: 'dropped',
            revision: 9,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
            incarnationId: currentIncarnationId,
            subject: { id: params.subjectId, label: 'Current entry', type: 'book' },
          },
        },
      }),
    }),
  } as unknown as KernelClient;
  return { client, calls };
}

const request = () => new Request('https://site.test/en/library', { headers: { authorization: 'Bearer test' } });

test('guarded changes and removals send the incarnation beside the existing revision', async () => {
  const { client, calls } = kernel();
  await changePersonalLibraryEntry(client, request(), {}, {
    subjectId,
    state: 'paused',
    revision: 4,
    incarnationId,
    idempotencyKey: key,
  });
  await removePersonalLibraryEntry(client, request(), {}, {
    subjectId,
    revision: 4,
    incarnationId,
    idempotencyKey: key,
  });
  expect(calls).toEqual([
    {
      method: 'PUT',
      body: { state: 'paused', revision: 4, incarnationId },
      options: { headers: { authorization: 'Bearer test', 'idempotency-key': key } },
    },
    {
      method: 'DELETE',
      body: undefined,
      options: {
        query: { revision: 4, incarnationId },
        headers: { authorization: 'Bearer test', 'idempotency-key': key },
      },
    },
  ]);
});

test('legacy null and absent incarnations preserve the base request shape', async () => {
  const { client, calls } = kernel();
  await changePersonalLibraryEntry(client, request(), {}, {
    subjectId,
    state: 'paused',
    revision: 4,
    incarnationId: null,
    idempotencyKey: key,
  });
  await removePersonalLibraryEntry(client, request(), {}, {
    subjectId,
    revision: 4,
    idempotencyKey: key,
  });
  expect(calls[0]?.body).toEqual({ state: 'paused', revision: 4 });
  expect(calls[1]?.options).toMatchObject({ query: { revision: 4 } });
  expect(Object.keys((calls[1]?.options as { query: object }).query)).toEqual(['revision']);
});

test('a stale incarnation reloads and returns the current entry without retrying either write', async () => {
  for (const action of ['change', 'remove'] as const) {
    const { client, calls } = kernel({ conflict: true });
    const result = action === 'change'
      ? await changePersonalLibraryEntry(client, request(), {}, {
          subjectId, state: 'paused', revision: 4, incarnationId, idempotencyKey: key,
        })
      : await removePersonalLibraryEntry(client, request(), {}, {
          subjectId, revision: 4, incarnationId, idempotencyKey: key,
        });
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      entry: { subjectId, state: 'dropped', revision: 9, incarnationId: currentIncarnationId },
    });
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
  }
});

test('no-JavaScript entry forms preserve the incarnation through their server action', async () => {
  const view = await readFile(join(root, 'src/library/shelf-view.tsx'), 'utf8');
  const actions = await readFile(join(root, 'src/library/entries-actions.ts'), 'utf8');
  expect(view).toMatch(/name=["']incarnationId["'][\s\S]*?type=["']hidden["']/);
  expect(actions).toMatch(/incarnationId/);
});

test('entry writes stay centralized in entries-read.ts', async () => {
  const { output, exitCode } = Bun.spawnSync([
    'rg', '-n', 'libraryEntries\\([^\\n]*\\)\\.(put|delete)', 'apps/web/src', '-g', '!library/entries-read.ts',
  ], { cwd: join(root, '../..'), stdout: 'pipe', stderr: 'pipe' });
  expect(exitCode).toBe(1);
  expect(output.toString()).toBe('');
});
