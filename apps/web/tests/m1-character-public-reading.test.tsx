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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionAddress, ConnectionVisit } from '../src/features/pages/subject-connections';
import type { ConnectionRead } from '../src/features/pages/subject-connections-window';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
const { characterPublicExample } = await import('../src/features/catalogue/character-public-reading/examples');
const { connectionReturnWindow } = await import('../src/features/pages/subject-visit-navigation');
const { CharacterReader } = await import('../src/features/pages/showcase-people/character');
const { m } = await import('../src/paraglide/messages.js');
const { OverviewContext } = await import('../src/features/pages/overview');
const { CharacterAssociationBridge, CharacterAssociationBinding } =
  await import('../src/features/catalogue/character-public-reading/bridge');
const { createConnectionWindow } = await import('../src/features/pages/subject-connections-window');

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

test('mounted profile associations preserve exact credits, disclosure, spoilers, current retry and retired visits', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(require.resolve('happy-dom', { paths: [require.resolve('@puckeditor/core')] }));
  const browser = new Window({ url: 'https://site.test/en/' });
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
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? browser : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : browser[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
  const fixture = characterPublicExample();
  let calls: ConnectionAddress[] = [];
  let response: ConnectionRead = fixture.read;
  const read: ConnectionRead = async (address, signal) => {
    calls.push(address);
    return response(address, signal);
  };
  let shared: ReturnType<typeof createConnectionWindow> | undefined;
  const render = async (source: object, viewer: string | null = null, context?: string) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            OverviewContext.Provider,
            {
              value: {
                ...fixture.value,
                realm: '00000000-0000-4000-8000-000000000006',
                ...(context ? { context: { id: context, population: { kind: 'global' as const } } } : {}),
              },
            },
            shared
              ? createElement(CharacterAssociationBridge, {
                  source,
                  children: createElement(CharacterAssociationBinding, {
                    source,
                    window: shared,
                    children: createElement(CharacterReader, {
                      public: fixture.profile.read,
                      release: fixture.profile.release,
                      locale: 'en',
                      associations: { source, viewer, read },
                    }),
                  }),
                })
              : createElement(CharacterReader, {
                  public: fixture.profile.read,
                  release: fixture.profile.release,
                  locale: 'en',
                  associations: { source, viewer, read },
                }),
          ),
        ),
      ),
    );
  const click = async (label: string, index = 0) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].filter((node) => node.textContent === label)[index];
      expect(button).toBeDefined();
      button!.click();
    });
  try {
    await render(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: fixture.value.subject,
      locale: 'en',
      release: fixture.value.releaseDigest,
      realm: '00000000-0000-4000-8000-000000000006',
    });
    expect(host.textContent).toContain('STEINS;GATE');
    expect(host.textContent).toContain('今井麻美');
    expect(host.textContent).toContain('Main role');
    expect(host.querySelector('[lang="ja"]')).not.toBeNull();
    const originalLinks = [...host.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes(m.character_work_original()),
    );
    expect(originalLinks.some((a) => a.getAttribute('href')?.includes('wdt%3AP725'))).toBe(true);
    expect(originalLinks.some((a) => a.getAttribute('href')?.includes('schema%3Acharacter'))).toBe(true);
    expect(host.innerHTML).toContain('https://bgm.tv/subject/10380');
    await click(m.subject_connections_next());
    expect(calls.at(-1)?.selection?.characters?.cursor).toBe('native-next');
    expect(host.textContent).toContain('STEINS;GATE 0');
    const work = [...host.querySelectorAll('a')].find((node) => node.textContent === 'STEINS;GATE 0')!;
    const via = new URL(work.href).searchParams.get('via')!;
    expect(connectionReturnWindow(new URL(via, 'https://site.test').hash)).toMatchObject({
      cursor: 'native-next',
      reading: 'b'.repeat(64),
      index: 1,
      history: [
        { reading: 'a'.repeat(64), page: 1 },
        { cursor: 'native-next', reading: 'b'.repeat(64), page: 2 },
      ],
    });
    await click(m.subject_connections_previous());
    expect(calls.at(-1)?.selection?.characters?.reading).toBe('a'.repeat(64));
    expect(host.textContent).not.toContain('STEINS;GATE 0');
    response = async () => {
      const value = fixture.visit();
      value.sections.characters!.section = { ok: false, status: 409 };
      return value;
    };
    await click(m.subject_connections_next());
    response = fixture.read;
    await click(m.subject_relation_restart());
    expect(calls.at(-1)?.selection?.characters?.cursor).toBeUndefined();
    expect(calls.at(-1)?.selection?.characters?.reading).toBeUndefined();
    const concealed = fixture.visit();
    const voice = concealed.sections.credits!.section;
    if (!voice.ok) throw Error('fixture');
    (voice.body.links as any[])[0].related = {};
    response = async () => concealed;
    await render({});
    expect(host.textContent).not.toContain('今井麻美');
    const spoiler = characterPublicExample('en', 'spoiler');
    response = spoiler.read;
    await render({});
    expect(host.innerHTML).not.toContain('STEINS;GATE');
    expect(host.querySelector('[data-slot="character-public-reading"]')!.innerHTML).not.toContain('bgm.tv');
    await click('Reveal');
    expect(host.textContent).toContain('STEINS;GATE');
    response = characterPublicExample('en', 'stale').read;
    await render({});
    expect(host.textContent).toContain(m.character_work_unavailable());
    response = characterPublicExample('en', 'unavailable').read;
    await render({});
    expect(host.innerHTML).not.toContain('STEINS;GATE');
    const member = '00000000-0000-4000-8000-000000000008';
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: member, csrfToken: 'member' });
    });
    response = fixture.read;
    await render({}, member);
    expect(calls.at(-1)?.viewer).toBe(member);
    expect(host.textContent).toContain('今井麻美');
    let settle!: (value: ConnectionVisit) => void;
    response = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    await render({}, member);
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
      client.setQueryData(['session'], { state: 'signed-in', subject: member, csrfToken: 'member-again' });
      settle(fixture.visit());
    });
    expect(host.innerHTML).not.toContain('STEINS;GATE');
    response = fixture.read;
    const source = {};
    const a = '00000000-0000-4000-8000-000000000001';
    await render(source, member, a);
    expect(calls.at(-1)?.context).toBe(a);
    await render(source, member, '00000000-0000-4000-8000-000000000002');
    await render(source, member, a);
    expect(host.innerHTML).not.toContain('STEINS;GATE');
    response = async () => {
      const suppressed = fixture.visit();
      for (const section of Object.values(suppressed.sections))
        if (section!.section.ok) section!.section.body.links = [];
      return suppressed;
    };
    await render({}, member, a);
    expect(calls.at(-1)?.context).toBe(a);
    expect(host.innerHTML).not.toContain('STEINS;GATE');
    response = fixture.read;
    shared = createConnectionWindow({ id: fixture.value.subject!, locale: 'en', viewer: member }, read);
    await act(async () => {
      await shared!.load();
    });
    const before = calls.length;
    await render({}, member);
    expect(host.textContent).toContain('今井麻美');
    expect(calls).toHaveLength(before); // The mounted Connections controller supplies the profile without another read.
  } finally {
    shared?.retire(true);
    await act(async () => root.unmount());
    client.clear();
    browser.happyDOM.abort();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
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
      expect(host.textContent).toContain(m.people_biography_unreadable());
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
