import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';

let request = new Request('https://site.test/en');
const headers = new Headers();
let prepareNext: () => Promise<void> = async () => {};
const prepareSession = mock(() => prepareNext());
const nativeCalls: { id: string; options: { fetch?: RequestInit; headers?: HeadersInit } }[] = [];
const document = {
  id: 'public-document',
  subjectId: 'public-subject',
  candidateId: 'public-statement',
  digest: 'a'.repeat(64),
  language: 'en',
  availability: 'available',
  body: {},
};
const kernelClient = mock(() => ({
  documents: ({ id }: { id: string }) => ({
    get: async (options: { fetch?: RequestInit; headers?: HeadersInit }) => {
      nativeCalls.push({ id, options });
      return { status: 200, data: { document } };
    },
  }),
}));

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('../src/kernel/client', () => ({
  configuredKernelOrigin: () => undefined,
  kernelClient,
  requestLocale: () => 'en',
}));
mock.module('../src/session/request', () => ({
  prepareSession,
  requestCsrfToken: () => null,
  sessionSubject: () => null,
  viewerCredential: () => undefined,
}));

const { readPublicSubjectDocument } = await import('../src/features/pages/subject-queries');
const realm = '00000000-0000-4000-8000-000000000301';

test('the native document GET receives its request lifetime and remains private no-store', async () => {
  const lifetime = new AbortController();
  request = new Request('https://site.test/en', { signal: lifetime.signal });
  nativeCalls.length = 0;
  headers.delete('cache-control');

  await readPublicSubjectDocument({ data: { documentId: document.id, locale: 'en', realm, reader: null } });

  expect(nativeCalls).toHaveLength(1);
  expect(nativeCalls[0]?.id).toBe(document.id);
  expect(nativeCalls[0]?.options.fetch?.signal).toBe(lifetime.signal);
  expect(nativeCalls[0]?.options.fetch?.cache).toBe('no-store');
  expect(headers.get('cache-control')).toBe('private, no-store');
});

test('retirement during Realm preparation prevents scheduling the document GET', async () => {
  const lifetime = new AbortController();
  request = new Request('https://site.test/en', { signal: lifetime.signal });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  prepareNext = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  const before = nativeCalls.length;
  const read = readPublicSubjectDocument({ data: { documentId: document.id, locale: 'en', realm, reader: null } });
  await started;
  lifetime.abort();
  release();

  await expect(read).rejects.toThrow();
  expect(nativeCalls).toHaveLength(before);
  prepareNext = async () => {};
});
