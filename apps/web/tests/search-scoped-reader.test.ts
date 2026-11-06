import { expect, mock, test } from 'bun:test';
let principal: string | undefined;
let credential: string | null = null;
let unavailable = false;
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => new Request('http://127.0.0.1/'), setResponseHeader() {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {
    if (unavailable) throw new Error('session unavailable');
  },
  sessionSubject: () => principal,
  viewerCredential: () => credential,
}));
const { readScopedSearchReader } = await import('../src/search/search-reader');
test('native scoped reads bind anonymous and signed-in readers without manufacturing bearer authority', async () => {
  const request = new Request('https://site.test/');
  expect(await readScopedSearchReader(request)).toEqual({ owner: '["signed-out"]', principal: 'anonymous' });
  principal = 'reader';
  credential = 'Bearer private';
  expect(await readScopedSearchReader(request)).toEqual({
    owner: '["signed-in","reader"]',
    principal: 'reader',
    authorization: credential,
  });
  principal = undefined;
  expect(await readScopedSearchReader(request)).toBeUndefined();
  credential = null;
  unavailable = true;
  await expect(readScopedSearchReader(request)).rejects.toThrow('session unavailable');
});
