import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { FollowWriteInput } from '../src/library/follow-records';

test('failed edge reads recover through exact retry, retire confirmed keys and refresh only own private readers', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/following' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const writes: FollowWriteInput[] = [];
  const unsettled: boolean[] = [];
  const boundary = { id: 'mounted-owner', lifetime: {} };
  mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
  mock.module('../src/library/history-current-origin', () => ({
    assertHistoryCurrent: () => {},
    useHistoryAddress: () => ({ key: 'address', isCurrent: () => true }),
    useHistoryCurrentOrigin: () => ({
      subject: 'owner',
      boundary,
      authoritative: true,
      lifetime: () => 'read',
      epoch: () => 0,
      current: () => true,
      credential: () => 'csrf',
      allowed: [true, true, true],
      retained: [true, true, true],
    }),
  }));
  mock.module('../src/library/follow-actions', () => ({
    readFollowState: async () => ({ state: 'unavailable' }),
    readCurrentFollowState: async () => {
      throw new Error('read interrupted');
    },
    setFollow: async ({ data }: { data: FollowWriteInput }) => {
      writes.push(data);
      return writes.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, following: data.following };
    },
  }));
  const { FollowTargetControl } = await import('../src/library/follow-target-control');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  const root = createRoot(host as unknown as HTMLElement);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
      expect(button.disabled).toBe(false);
      button.click();
      await tick();
    });
  for (const kind of ['mine-following', 'library-private-follow-counts'])
    for (const viewer of ['owner', 'other']) client.setQueryData([kind, viewer], { count: 17 });
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FollowTargetControl
            targetId="hidden-original"
            idempotencyKey="123e4567-e89b-42d3-a456-426614174000"
            onRemovalUnsettledChange={(_targetId, pending) => unsettled.push(pending)}
          />
        </QueryClientProvider>,
      );
      await tick();
    });
    await click('Unfollow');
    await click('Unfollow');
    await click('Follow');
    await click('Unfollow');
    expect(writes.map((input) => input.following)).toEqual([false, false, true, false]);
    expect(unsettled).toEqual([true, false, true, false]);
    expect(writes[1]).toBe(writes[0]);
    expect(new Set(writes.map((input) => input.idempotencyKey)).size).toBe(3);
    expect(writes.every((input) => input.targetId === 'hidden-original')).toBe(true);
    for (const kind of ['mine-following', 'library-private-follow-counts']) {
      expect(client.getQueryState([kind, 'owner'])?.isInvalidated).toBe(true);
      expect(client.getQueryState([kind, 'other'])?.isInvalidated).toBe(false);
      expect(client.getQueryData([kind, 'owner'])).toEqual({ count: 17 });
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
