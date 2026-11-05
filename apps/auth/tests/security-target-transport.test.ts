import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  readSecurityTarget,
  performSecurityAction,
  securityTargetBrowserTransport as transport,
  type SecurityActionResult,
} from '../src/security-reconciliation';
import { initial } from '../src/stories/accounts-security/security/security.stories';

const target = {
  accountId: initial.kind === 'ready' ? initial.accountId : '',
  kind: 'session' as const,
  id: 'current',
};
const timeout = globalThis.setTimeout;
const timers: { callback: () => void; delay: number; timer: ReturnType<typeof setTimeout> }[] = [];
let clock: ReturnType<typeof spyOn> | undefined;
function controlTime() {
  clock = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const timer = timeout(callback, 60_000);
    timers.push({ callback, delay, timer });
    return timer;
  }) as typeof setTimeout);
}
function expire(delay: number) {
  for (const item of timers.splice(0)) {
    clearTimeout(item.timer);
    if (item.delay === delay) item.callback();
  }
}
afterEach(() => {
  clock?.mockRestore();
  for (const item of timers.splice(0)) clearTimeout(item.timer);
});

test.each(['waiting', 'completion'])(
  'browser BFF %s is within the private-read deadline even when abort is ignored',
  async (phase) => {
    controlTime();
    const late = Promise.withResolvers<any>();
    let signal: AbortSignal | undefined;
    const read = spyOn(transport, 'read').mockImplementation(async (value, current) => {
      expect(value).toEqual(target);
      signal = current;
      // Completion includes deserializing the BFF response, not just receiving headers.
      if (phase === 'completion') return new Response(new ReadableStream()).json() as any;
      return late.promise;
    });
    try {
      const pending = readSecurityTarget(target);
      await Promise.resolve();
      expire(5000);
      expect(await pending).toEqual({ kind: 'unavailable' });
      expect(signal?.aborted).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      late.resolve({ kind: 'signed-out' });
      expect(await pending).toEqual({ kind: 'unavailable' });
    } finally {
      read.mockRestore();
    }
  },
);

test('one bounded browser action dispatch becomes unknown, preserves caller abort and rejects malformed acknowledgement', async () => {
  controlTime();
  const late = Promise.withResolvers<SecurityActionResult>();
  let signal: AbortSignal | undefined;
  const write = spyOn(transport, 'act').mockImplementation((value, current) => {
    expect(value).toEqual(target);
    signal = current;
    return late.promise;
  });
  try {
    const pending = performSecurityAction(target);
    await Promise.resolve();
    expire(12_000);
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(signal?.aborted).toBe(true);
    late.resolve({ kind: 'accepted' });
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(write).toHaveBeenCalledTimes(1);
    write.mockImplementation((_, current) => {
      signal = current;
      return new Promise(() => {});
    });
    const caller = new AbortController();
    const cancelled = performSecurityAction(target, caller.signal);
    await Promise.resolve();
    caller.abort();
    expect(await cancelled).toEqual({ kind: 'unknown' });
    expect(signal?.aborted).toBe(true);
    write.mockResolvedValue({ kind: 'accepted', sessionEnded: 'invalid' } as any);
    expect(await performSecurityAction(target)).toEqual({ kind: 'unknown' });
    write.mockRejectedValue(new Error('lost transport'));
    expect(await performSecurityAction(target)).toEqual({ kind: 'unknown' });
    const count = write.mock.calls.length;
    expect(await performSecurityAction(target, caller.signal)).toEqual({ kind: 'failure' });
    expect(write).toHaveBeenCalledTimes(count);
  } finally {
    write.mockRestore();
  }
});

test('readback validates the closed current page and cannot invent absence from malformed or limited inventory', async () => {
  if (initial.kind !== 'ready') throw new Error('fixture');
  const page = structuredClone(initial.page!);
  const read = spyOn(transport, 'read').mockResolvedValue({
    kind: 'ready',
    page,
    sessions: [],
    passkeys: [],
    presence: 'absent',
  });
  try {
    expect((await readSecurityTarget(target)).kind).toBe('ready');
    expect(await readSecurityTarget({ ...target, id: 'missing' })).toMatchObject({ presence: 'absent' });
    if (page.sessions.kind === 'ready') page.sessions.truncated = true;
    expect(await readSecurityTarget({ ...target, id: 'missing' })).toMatchObject({
      kind: 'ready',
      presence: 'unknown',
    });
    read.mockResolvedValue({ kind: 'ready', page: {} } as any);
    expect(await readSecurityTarget(target)).toEqual({ kind: 'unavailable' });
  } finally {
    read.mockRestore();
  }
});
