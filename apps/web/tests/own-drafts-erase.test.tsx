import { expect, test } from 'bun:test';
import { act } from 'react';
import type { OwnDraftCommands, OwnDraftReader } from '../src/threads/own-drafts/model';
import { accountId, identity, mountOwnDrafts, row, selected } from './own-drafts-fixture';

function episode() {
  const first = row();
  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000009';
  const other = row({
    id,
    title: 'Another draft',
    actions: {
      resume: `/v1/accounts/${accountId}/drafts/${id}?threadId=${first.threadId}`,
      edit: `/v1/posts/${id}/revisions`,
      publish: `/v1/posts/${id}/revisions`,
      erase: `/v1/posts/${id}`,
    },
  });
  let epoch = 2;
  let stale = false;
  let unavailable = false;
  const reader: OwnDraftReader = {
    list: async ({ cursor }) =>
      unavailable
        ? 'unavailable'
        : {
            state: 'ready',
            viewer: { accountId, authnEpoch: epoch },
            drafts: cursor ? [other] : [first],
            next: cursor ? null : 'older',
          },
    resume: async ({ id }) => (stale ? 'stale' : selected(id === first.id ? first : other)),
  };
  const calls: Parameters<OwnDraftCommands['erase']>[0][] = [];
  let signal: AbortSignal | undefined;
  let settle!: (value: Awaited<ReturnType<OwnDraftCommands['erase']>>) => void;
  const commands: OwnDraftCommands = {
    write: async () => ({ ok: false, reason: 'unavailable' }),
    erase: async (input, requestSignal) => {
      calls.push(structuredClone(input));
      signal = requestSignal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    readback: async () => 'concealed',
  };
  return {
    reader,
    commands,
    calls,
    stale: (value = true) => {
      stale = value;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    signal: () => signal,
    epoch: () => {
      epoch++;
    },
    settle: async (value: Parameters<typeof settle>[0]) => {
      await act(async () => settle(value));
    },
  };
}

test('in-flight erase survives pagination, another inspection, refresh/restart and exact retry without a selected row', async () => {
  const e = episode();
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader: e.reader, commands: e.commands });
    await f.click('Inspect draft privately');
    await f.click('Erase draft');
    await f.click('Confirm erase');
    await f.click('Return to drafts');
    await f.click('Continue to older drafts');
    await f.click('Inspect draft privately');
    expect(e.signal()?.aborted).toBe(false);
    expect(f.host.textContent).toContain('Erasing draft');
    for (const label of ['Erase draft', 'Use server-saved body in editor'])
      expect([...f.host.querySelectorAll('button')].find((b) => b.textContent === label)?.disabled).toBe(true);
    await e.settle({ ok: false, reason: 'unavailable' });
    expect(f.host.textContent).toContain('Retry the same erase');
    await f.click('Return to drafts');
    await f.click('Retry the same erase');
    expect(e.calls).toHaveLength(2);
    expect(e.calls[1]).toEqual(e.calls[0]);
    e.stale();
    await f.click('Inspect draft privately');
    e.unavailable(true);
    await f.click('Restart inventory');
    expect(e.signal()?.aborted).toBe(false);
    e.unavailable(false);
    await f.click('Retry this page');
    await e.settle({ ok: false, reason: 'unavailable' });
    await f.click('Retry the same erase');
    expect(e.calls[2]).toEqual(e.calls[0]);
    await e.settle({ ok: false, reason: 'conflict' });
    e.stale(false);
    await f.click('Inspect draft privately');
    expect(
      [...f.host.querySelectorAll('button')].find((b) => b.textContent === 'Use server-saved body in editor')?.disabled,
    ).toBe(false);
    expect(e.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test.each(['account', 'session', 'inactive', 'native epoch'] as const)(
  '%s retirement removes recovery and ignores late erase results',
  async (change) => {
    const e = episode();
    const f = await mountOwnDrafts();
    try {
      const props = { identity, active: true, reader: e.reader, commands: e.commands };
      await f.render(props);
      await f.click('Inspect draft privately');
      await f.click('Erase draft');
      await f.click('Confirm erase');
      await f.click('Return to drafts');
      if (change === 'native epoch') {
        e.epoch();
        await f.click('Continue to older drafts');
      } else
        await f.render({
          ...props,
          active: change !== 'inactive',
          identity:
            change === 'account'
              ? { ...identity, accountId: 'another-account' }
              : change === 'session'
                ? { ...identity, callerEpoch: 'replacement' }
                : identity,
        });
      expect(e.signal()?.aborted).toBe(true);
      await e.settle({ ok: true });
      expect(f.host.textContent).not.toContain('The erase request was acknowledged');
      expect(f.host.textContent).not.toContain('Retry the same erase');
      expect(f.host.textContent).not.toContain('Erasing draft');
      expect(e.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
