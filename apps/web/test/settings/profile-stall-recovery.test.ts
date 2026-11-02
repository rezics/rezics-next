import { expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { AccountProfileEditor } from '../../src/accounts/profile-editor/editor';
import { writeTarget } from '../../src/accounts/profile-editor/data';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from '../../src/settings/profile-data';
import { withProfileDeadline } from '../../src/settings/profile-request-deadline';

const accountId = '019a0000-0000-7000-8000-000000000001';
const profile: ProfileValues = {
  accountId,
  kind: 'actor',
  displayName: 'Before',
  biography: null,
  avatar: null,
  links: [],
  publicViews: { posts: false, reviews: false, collections: false, realms: false },
};
const after = { ...profile, displayName: 'After' };
const never = <T>(): Promise<T> => new Promise(() => {});
async function fast(run: () => Promise<void>) {
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    schedule(callback, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
  try {
    await run();
  } finally {
    timer.mockRestore();
  }
}

test('native profile GET and both PATCH adapters bound stalled headers and bodies', () =>
  fast(async () => {
    for (const phase of ['headers', 'body']) {
      const signals: AbortSignal[] = [];
      let reading = true;
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          signals.push(request.signal);
          if (!reading && request.method === 'GET')
            return Response.json({
              profile: {
                ...profile,
                id: accountId,
                accountId: undefined,
                handle: null,
                bio: null,
                biography: undefined,
              },
            });
          return phase === 'headers'
            ? never<Response>()
            : new Response(new ReadableStream(), {
                headers: { 'content-type': 'application/json' },
              });
        }) as typeof fetch,
      });
      await expect(loadProfileRecord(client, 'Bearer current', accountId)).rejects.toThrow('timed out');
      reading = false;
      await expect(
        saveProfileRecord(client, 'Bearer current', accountId, profile, after, crypto.randomUUID()),
      ).rejects.toThrow('timed out');
      await expect(
        writeTarget(client, 'Bearer current', {
          accountId,
          viewerId: accountId,
          confirmed: true,
          patch: { displayName: 'After' },
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toThrow('timed out');
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false, true]);
    }
  }));

test('initial read, unknown PATCH and readback recover deliberately with the same command and later draft', () =>
  fast(async () => {
    let reads = 0;
    let writes = 0;
    let late!: (value: ProfileValues) => void;
    const attempts: unknown[] = [];
    const editor = new AccountProfileEditor({
      read: async () =>
        ++reads === 1
          ? never()
          : reads === 3
            ? new Promise((resolve) => {
                late = resolve;
              })
            : reads >= 4
              ? after
              : profile,
      save: async (attempt) => {
        attempts.push(attempt);
        return ++writes === 1 ? never() : { ok: true, profile: after };
      },
    });
    await editor.reload();
    expect(editor.snapshot().phase).toBe('unavailable');
    await editor.reload();
    editor.edit({ displayName: 'After' });
    await editor.submit('profile');
    await editor.confirm();
    const attempt = editor.snapshot().attempt;
    expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', draft: after });
    editor.edit({ biography: 'Later draft' });
    await editor.retry();
    expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', attempt, readStatus: 'failed' });
    expect(attempts).toEqual([attempt, attempt]);
    late({ ...after, accountId: 'wrong-account', biography: 'Obsolete' });
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      attempt: null,
      known: after,
      draft: { displayName: 'After', biography: 'Later draft' },
    });
    expect(writes).toBe(2);
    editor.retire();
  }));

test('cancellation releases resources, prevents dispatch and retirement aborts observation', async () => {
  const caller = new AbortController();
  const remove = spyOn(caller.signal, 'removeEventListener');
  const clear = spyOn(globalThis, 'clearTimeout');
  let child!: AbortSignal;
  try {
    const pending = withProfileDeadline((signal) => {
      child = signal;
      return never();
    }, caller.signal);
    caller.abort(new Error('retired'));
    await expect(pending).rejects.toThrow('retired');
    await expect(
      withProfileDeadline(() => {
        throw new Error('dispatched');
      }, caller.signal),
    ).rejects.toThrow('retired');
    expect(child.aborted).toBe(true);
    expect(await withProfileDeadline(async () => 'ready')).toBe('ready');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledTimes(3);
  } finally {
    remove.mockRestore();
    clear.mockRestore();
  }
  const editor = new AccountProfileEditor({
    read: async (signal) => {
      child = signal!;
      return never();
    },
    save: never,
  });
  const pending = editor.reload();
  editor.retire();
  await pending;
  expect(child.aborted).toBe(true);
  expect(editor.snapshot()).toMatchObject({ known: null, draft: null, attempt: null });
});
