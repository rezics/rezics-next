import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRequire } from 'node:module';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createHash } from 'node:crypto';
import type { KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { peopleFactsExample } from '../src/features/catalogue/people-facts/examples';
import definitions from '../../../packages/definitions/release/rezics.json';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
const { CharacterReader } = await import('../src/features/pages/showcase-people/character');

test('the Character voice stream uses the released P453 slot key and keeps P725 target as performer', async () => {
  const { connectionStreams, readConnectionStream } = await import('../src/features/pages/subject-connections');
  const id = '01a1a7f2-b438-779d-be96-aa19ca250569';
  const release = definitions as unknown as GuideRelease;
  const stream = connectionStreams(release, 'wd:Q95074', id, 'en').find((item) => item.property === 'wdt:P725');
  expect(stream).toMatchObject({
    key: 'in:wdt:P725:qualified',
    direction: 'in',
    group: 'credits',
    filter: id,
    qualifier: 'wdt:P453',
  });
  const requests: unknown[] = [];
  const client = {
    subjects: () => ({
      links: {
        get: async (options: unknown) => {
          requests.push(options);
          return {
            status: 200,
            data: {
              links: [],
              next: null,
              partial: true,
              freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
            },
          };
        },
      },
    }),
  } as unknown as KernelClient;
  const result = await readConnectionStream(client, { id, locale: 'en' }, stream!, undefined, undefined, undefined, {
    calls: 0,
    values: 0,
    bytes: 0,
  });
  expect(result.ok).toBe(true);
  expect(result.ok && result.body.partial).toBe(true);
  expect(requests[0]).toMatchObject({
    query: { property: 'wdt:P725', filter: id, qualifier: 'wdt:P453', limit: 12 },
  });
});

test('the mounted Character profile uses exact native documents and withholds mismatched or unavailable bodies', async () => {
  const fixture = peopleFactsExample(true);
  const body = fromPlainText('The supplied public Character biography.');
  const digest = createHash('sha256').update(serializeDocument(body)).digest('hex');
  const document = '00000000-0000-4000-8000-000000000099';
  const statement = fixture.statement('schema:abstract', { document, digest, language: 'en' }, 'document');
  fixture.read.subject.statements = { 'schema:abstract': [statement] };
  const exact = {
    id: document,
    subjectId: fixture.read.subject.id,
    candidateId: statement.id,
    digest,
    language: 'en',
    availability: 'available',
    body,
    revision: 1,
    origin: 'account',
    author: fixture.read.subject.id,
    licence: 'CC-BY-4.0',
  };
  const require = createRequire(import.meta.url);
  const { Window } = await import(require.resolve('happy-dom', { paths: [require.resolve('@puckeditor/core')] }));
  const window = new Window();
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = (value: unknown) =>
    act(async () => {
      root.render(
        createElement(CharacterReader, {
          public: { ...fixture.read, documents: { [statement.id]: value } } as typeof fixture.read,
          locale: 'en',
          release: fixture.release,
        }),
      );
    });
  try {
    await render(exact);
    expect(host.textContent).toContain('The supplied public Character biography.');
    for (const mismatch of [
      { id: 'other' },
      { subjectId: 'other' },
      { candidateId: 'other' },
      { digest: '0'.repeat(64) },
      { language: 'ja' },
      { availability: 'erased' },
      { body: {} },
    ]) {
      await render({ ...exact, ...mismatch });
      expect(host.textContent).not.toContain('The supplied public Character biography.');
    }
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
