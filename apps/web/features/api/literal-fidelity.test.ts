import { afterEach, expect, test } from 'bun:test';
import { browserMainApi } from './browser.ts';
import { mainApiWithToken } from './main.ts';

/** Lexical forms Main can return. Eden's default reviver would turn the first two into Dates. */
const recorded = {
  lexical: '1980-04-01',
  recordedAt: '2026-10-09T00:00:00Z',
  year: '1980',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('server and browser API clients keep date-shaped literals as the strings the API returned', async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(recorded)) as typeof fetch;
  const server = await mainApiWithToken(undefined).v1.types.get();
  const browser = await browserMainApi('http://127.0.0.1:3001').v1.types.get();
  // The route's contract type is unrelated; this checks the JSON the clients actually parsed.
  for (const data of [server.data, browser.data] as unknown[]) {
    expect(data).toEqual(recorded);
  }
});
