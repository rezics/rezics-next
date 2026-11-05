import { afterAll, expect, test } from 'bun:test';
import { loadAccountDeletionPage } from '../src/account-deletion-page';

const maxBytes = 2375;
const original = globalThis.fetch;
const encoder = new TextEncoder();
const maximum = {
  kind: 'review',
  accountId: '\0'.repeat(128),
  email: `${'\0'.repeat(249)}@\0.\0\0`,
  action: 'available',
  policy: 'personal-deletion',
};
const maximumBytes = encoder.encode(JSON.stringify(maximum));
afterAll(() => {
  globalThis.fetch = original;
});

function streamed(bytes: Uint8Array, split?: number, headers?: HeadersInit, uncooperative = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split ?? bytes.length));
        if (split !== undefined) controller.enqueue(bytes.slice(split));
        if (!uncooperative) controller.close();
      },
      cancel() {
        if (uncooperative) return new Promise<void>(() => {});
      },
    }),
    { headers },
  );
}

function read(response: Response) {
  const caller = new AbortController();
  let requests = 0;
  response.json = async () => {
    throw new Error('response.json bypasses the bounded reader');
  };
  globalThis.fetch = (async (path, init) => {
    requests++;
    expect(path).toBe('/account-management/deletion-page');
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(caller.signal);
    return response;
  }) as typeof fetch;
  return loadAccountDeletionPage(caller.signal).then((page) => {
    expect(requests).toBe(1);
    return page;
  });
}

async function settles<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('bounded read hung on cancellation')), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('one closed same-origin page read rejects authority and unrecognized advice fields', async () => {
  const readBody = (body: unknown) => read(Response.json(body));
  for (const body of [
    { kind: 'signed-out' },
    { kind: 'authentication-required', accountId: 'self' },
    { kind: 'review', accountId: 'self', email: null, action: 'refused', policy: 'personal-deletion' },
  ])
    expect(await readBody(body)).toEqual(body);
  for (const body of [
    { kind: 'available' },
    { kind: 'review', accountId: 'self', action: 'available' },
    { kind: 'authentication-required', accountId: 'self', token: 'secret' },
    {
      kind: 'review',
      accountId: 'self',
      email: null,
      action: 'available',
      policy: 'personal-deletion',
      targetAccountId: 'other',
    },
  ])
    expect(await readBody(body)).toEqual({ kind: 'unavailable' });
});

test('accepts maximum escaped fields and UTF-8 split across chunks', async () => {
  expect(maximumBytes.byteLength).toBe(maxBytes);
  expect(await read(streamed(maximumBytes))).toEqual(maximum);

  const split = { ...maximum, accountId: `é${'\0'.repeat(127)}`, email: null };
  const json = JSON.stringify(split);
  const bytes = encoder.encode(json);
  const afterFirstUtf8Byte = encoder.encode(json.slice(0, json.indexOf('é'))).byteLength + 1;
  expect(await read(streamed(bytes, afterFirstUtf8Byte))).toEqual(split);
});

test('overflow stays unavailable with absent or dishonest length and never waits for cancel', async () => {
  const overflow = new Uint8Array(maximumBytes.length + 1);
  overflow.set(maximumBytes);
  overflow[maximumBytes.length] = 0x20;
  const absentLength = streamed(overflow, undefined, undefined, true);
  const dishonestLength = streamed(overflow, maximumBytes.length, { 'Content-Length': '1' });
  expect(absentLength.headers.has('content-length')).toBe(false);
  expect(dishonestLength.headers.get('content-length')).toBe('1');
  for (const response of [absentLength, dishonestLength])
    expect(await settles(read(response))).toEqual({ kind: 'unavailable' });
});

test('absent bodies, malformed UTF-8 and malformed JSON remain unavailable', async () => {
  for (const response of [new Response(null), new Response(new Uint8Array([0xff])), new Response('{broken')])
    expect(await read(response)).toEqual({ kind: 'unavailable' });
});
