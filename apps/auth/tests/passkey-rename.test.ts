import { afterEach, expect, test } from 'bun:test';
import { createPasskeyRename, renamePasskey, PASSKEY_RENAME_RESPONSE_BYTES } from '../src/passkey-rename';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const command = () => createPasskeyRename('human', 'opaque-native-passkey-id', ' Travel key ')!;

test('rename snapshots the exact account/credential/label and admits only its exact acknowledgement', async () => {
  const submitted: unknown[] = [];
  globalThis.fetch = (async (_path, init) => {
    submitted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: command().id, name: command().name });
  }) as typeof fetch;
  expect(Object.isFrozen(command())).toBe(true);
  expect(createPasskeyRename('human', 'key', ' ')).toBeNull();
  expect(createPasskeyRename('human', 'key', 'a'.repeat(129))).toBeNull();
  expect(await renamePasskey(command(), new AbortController().signal, () => {})).toEqual({
    kind: 'acknowledged',
    id: command().id,
    name: 'Travel key',
  });
  expect(submitted).toEqual([{ id: command().id, name: 'Travel key', reviewed_account_id: 'human' }]);
  for (const body of [
    { id: 'another-key', name: command().name },
    { id: command().id, name: 'Another name' },
    { id: command().id, name: command().name, publicKey: 'private native metadata' },
  ]) {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    expect(await renamePasskey(command(), new AbortController().signal, () => {})).toEqual({ kind: 'unknown' });
  }
});

test('interruption after one dispatch stays unknown without replay; an already retired caller sends nothing', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return new Promise(() => {});
  }) as typeof fetch;
  const caller = new AbortController();
  const result = renamePasskey(command(), caller.signal, () => caller.abort());
  expect(await result).toEqual({ kind: 'unknown' });
  expect(calls).toBe(1);
  expect(await renamePasskey(command(), caller.signal, () => {})).toEqual({ kind: 'not-dispatched' });
  expect(calls).toBe(1);
});

test('overflow and body cancellation cannot confirm a rename; native refusal is distinct from unavailable', async () => {
  globalThis.fetch = (async () => new Response(' '.repeat(PASSKEY_RENAME_RESPONSE_BYTES + 1))) as typeof fetch;
  expect(await renamePasskey(command(), new AbortController().signal, () => {})).toEqual({ kind: 'unknown' });
  for (const [status, error, kind] of [
    [409, 'credential_effect_denied', 'refused'],
    [401, 'step_up_required', 'step-up'],
    [503, 'credential_effect_denied', 'unknown'],
  ] as const) {
    globalThis.fetch = (async () => Response.json({ error, effect_status: 'not_applied' }, { status })) as typeof fetch;
    expect(await renamePasskey(command(), new AbortController().signal, () => {})).toEqual({ kind });
  }
  const caller = new AbortController();
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start() {
          queueMicrotask(() => caller.abort());
        },
      }),
    )) as typeof fetch;
  expect(await renamePasskey(command(), caller.signal, () => {})).toEqual({ kind: 'unknown' });
});

test('the five-second lifetime ends an uncooperative transport without replay', async () => {
  let sends = 0;
  globalThis.fetch = (() => {
    sends++;
    return new Promise(() => {});
  }) as typeof fetch;
  expect(await renamePasskey(command(), new AbortController().signal, () => {})).toEqual({ kind: 'unknown' });
  expect(sends).toBe(1);
}, 7000);
