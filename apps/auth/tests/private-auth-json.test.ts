import { expect, spyOn, test } from 'bun:test';
import { readJsonBounded } from '../src/private-auth-json';
import { privateAuthRead } from '../src/private-auth-read';
import { loadSignInPage } from '../src/signin-page';

const encode = (text: string) => new TextEncoder().encode(text);
const signal = () => new AbortController().signal;
const unavailable = 'Private JSON response unavailable';

test('the exact byte allowance accepts split UTF-8; invalid bodies disclose no parser excerpts', async () => {
  const bytes = encode('"é🙂"');
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  expect(await readJsonBounded(new Response(body), bytes.length, signal())).toBe('é🙂');
  for (const response of [new Response(null), new Response(''), new Response('secret-identifier'),
    new Response(Uint8Array.of(34, 255, 34)), new Response(new ReadableStream({ start(c) { c.error('secret'); } }))])
    await expect(readJsonBounded(response, 32, signal())).rejects.toThrow(unavailable);
});

test('excess cancels without trusting missing, small or malformed Content-Length or awaiting cancel', async () => {
  for (const length of [null, '1', 'nonsense', '999']) {
    let cancelled = false;
    const body = new ReadableStream({
      start(c) { c.enqueue(encode('"')); c.enqueue(encode('xxxx')); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const response = new Response(body, { headers: length === null ? {} : { 'content-length': length } });
    await expect(readJsonBounded(response, 4, signal())).rejects.toThrow(unavailable);
    expect(cancelled).toBe(true);
  }
});

test('abort before reading and the existing whole-call deadline cancel an uncooperative body', async () => {
  const caller = new AbortController();
  caller.abort();
  let expire!: () => void;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    expect(ms).toBe(5000); expire = fn; return 0;
  }) as typeof setTimeout);
  try {
    for (const initial of [caller.signal, undefined]) {
      let cancelled = false;
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }));
      const read = initial ? readJsonBounded(response, 16, initial)
        : privateAuthRead((deadline) => readJsonBounded(response, 16, deadline));
      await Promise.resolve();
      if (!initial) expire();
      await expect(read).rejects.toBeInstanceOf(Error);
      expect(cancelled).toBe(true);
    }
    expect(timer).toHaveBeenCalledTimes(1);
  } finally { timer.mockRestore(); }
});

test('the installed sign-in seam keeps 16 KiB and never publishes a streamed excess', async () => {
  const json = JSON.stringify({ methods: { password: true, passkey: true }, viewer: { kind: 'signed-out' },
    continuation: { href: '/security', requires_sign_in: true } });
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(json.padEnd(16384)))
    .mockResolvedValueOnce(new Response(json.padEnd(16385), { headers: { 'content-length': '1' } }));
  try {
    expect((await loadSignInPage('', 'https://auth.example.test')).kind).toBe('ready');
    expect(await loadSignInPage('', 'https://auth.example.test')).toEqual({ kind: 'unavailable' });
  } finally { fetch.mockRestore(); }
});
