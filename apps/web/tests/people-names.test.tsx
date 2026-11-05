import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Subject } from '../src/subject/types';
import { peopleNames, filterPeopleNames, peopleNamesAdvice } from '../src/features/catalogue/people-names/model';
import { PeopleNamesEntry, type PeopleNamesReading } from '../src/features/catalogue/people-names/entry';
import { WORK_NAMES_BYTES, supportsWorkNames } from '../src/features/catalogue/work-names/model';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { characterRelationshipsFixture } from '../src/kernel/fake/character-relationships';
import { contextHref } from '../src/features/pages/context-navigation';
import type { TermsPageAuthority } from '../src/features/catalogue/subject-terms';
import { locales } from '../src/paraglide/runtime';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonReader } = await import('../src/features/catalogue/person-reader/reader');
const { CharacterReader } = await import('../src/features/pages/showcase-people/character');
const languages = [
  'en',
  'ja',
  'zh-Hant',
  'fr',
  'de',
  'es',
  'ko',
  'ar',
  'he',
  'it',
  'pt',
  'ru',
  'uk',
  'nl',
  'sv',
  'da',
  'fi',
  'pl',
  'cs',
  'tr',
];
function supplied(subject: Subject) {
  subject.labels = Object.fromEntries(languages.map((lang) => [lang, `名・${lang}`]));
  subject.aliases = {
    en: Array.from({ length: 40 }, (_, index) => `alias-${index}`),
    tr: ['Exact—Mél/旅'],
    ja: ['名・ja', '名･ja'],
  };
  return subject;
}
const allowed: TermsPageAuthority = {
  viewer: 'signed-in',
  actions: {
    state: 'ready',
    actions: [{ action: 'statement:propose', operations: ['subject.terms'] }],
  },
};
const denied: TermsPageAuthority = { viewer: 'signed-in', actions: { state: 'ready', actions: [] } };

test('shared whole-response admission retains every supplied language, spelling and role; invalid and empty differ', () => {
  const subject = supplied(personReaderExample().read.subject);
  const names = peopleNames(subject, 'zh-Hans');
  expect(names.state).toBe('ready');
  if (names.state !== 'ready') throw new Error('Expected admitted names');
  expect(names.groups).toHaveLength(20);
  expect(names.groups[0]?.names).toHaveLength(41);
  expect(names.groups[1]?.names[0]).toEqual({ text: '名・ja', roles: ['title', 'alias'] });
  expect(filterPeopleNames(names.groups, 'Mél')[0]?.names[0]?.text).toBe('Exact—Mél/旅');
  expect(filterPeopleNames(names.groups, 'Mel')).toHaveLength(0);
  expect(filterPeopleNames(names.groups, '名･ja')[0]?.names).toHaveLength(1);
  expect(supportsWorkNames(subject.type)).toBe(false);
  expect(peopleNames({ ...subject, labels: { ja: '本来の名前' } }, 'en')).toMatchObject({
    selected: { text: '本来の名前', lang: 'ja' },
  });
  expect(peopleNames({ ...subject, labels: {}, aliases: {} }, 'en')).toMatchObject({ state: 'ready', groups: [] });
  expect(peopleNames({ ...subject, aliases: { en: 'bad container' } } as unknown as Subject, 'en').state).toBe(
    'malformed',
  );
  expect(peopleNames({ ...subject, labels: { invalid_tag: 'Name' } }, 'en').state).toBe('malformed');
  expect(peopleNames({ ...subject, aliases: { en: ['旅'.repeat(WORK_NAMES_BYTES)] } }, 'en').state).toBe('oversized');
  expect(peopleNamesAdvice(allowed)).toBe('allowed');
  expect(
    peopleNamesAdvice({
      viewer: 'signed-in',
      actions: {
        state: 'ready',
        actions: [{ action: 'subject:create', operations: ['subject.create', 'subject.update'] }],
      },
    }),
  ).toBe('denied');
});

test('actual Person and Character callers retain independent identities and bounded local projection at 64/512/4096 unrelated summaries', () => {
  const person = personReaderExample();
  const character = characterRelationshipsFixture();
  supplied(person.read.subject);
  supplied(character.character.subject);
  for (const size of [64, 512, 4096]) {
    for (const read of [person.read, character.character]) {
      read.related = Object.fromEntries(
        Array.from({ length: size }, (_, index) => [
          crypto.randomUUID(),
          {
            type: 'schema:Person',
            labels: { en: `Unrelated history ${index}` },
          },
        ]),
      );
    }
    for (const locale of locales) {
      for (const [Component, read, release] of [
        [PersonReader, person.read, person.release],
        [CharacterReader, character.character, character.release],
      ] as const) {
        const html = renderToStaticMarkup(h(Component, { public: read, release, locale }));
        expect(html).toContain('id="supplied-names"');
        expect(html).toContain('lang="ja"');
        expect(html).toContain('dir="auto"');
        expect(html).toContain(`/${locale}/subjects/${read.subject.id}/`);
        expect(html).not.toContain('Unrelated history');
        expect(html).not.toContain('<h1');
        expect(peopleNames(read.subject, locale)).toMatchObject({
          state: 'ready',
          groups: expect.arrayContaining([
            {
              language: 'tr',
              names: [
                { text: '名・tr', roles: ['title'] },
                { text: 'Exact—Mél/旅', roles: ['alias'] },
              ],
            },
          ]),
        });
      }
    }
  }
  expect(person.read.subject.id).not.toBe(character.character.subject.id);
  const oversized = structuredClone(person.read);
  oversized.subject.aliases = { ja: ['名'.repeat(WORK_NAMES_BYTES)] };
  const html = renderToStaticMarkup(
    h(PersonReader, { public: oversized, release: person.release, documents: person.documents, locale: 'en' }),
  );
  expect(html).toContain('too large');
  expect(html).toContain('Mira directs independent films.');
});

test('mounted signed-out search, overflow, exact copying, advice retry and A-B-A callbacks stay local to their visit', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const fixture = personReaderExample();
  supplied(fixture.read.subject);
  const A: PeopleNamesReading = {
    public: fixture.read,
    locale: 'en',
    link: (props) =>
      h('a', {
        ...props,
        href: contextHref(props.href, '00000000-0000-4000-8000-000000000777'),
      }),
  };
  let reads = 0;
  let reply: () => Promise<TermsPageAuthority> = async () => {
    throw new Error('advice offline');
  };
  const adviceLoader = () => {
    reads++;
    return reply();
  };
  const draw = (reading = A) =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h('main', {}, h('h1', {}, 'The original profile'), h(PeopleNamesEntry, { reading, adviceLoader })),
        ),
      ),
    );
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const click = (node: HTMLElement) => act(async () => node.click());
  let copied = '';
  let write = async (text: string) => {
    copied = text;
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => write(text) },
  });
  try {
    await draw();
    expect(reads).toBe(0);
    expect(host.textContent).toContain('signed out');
    expect(host.querySelector('details')?.open).toBe(false);
    host.querySelector('details')!.open = true;
    host.querySelector<HTMLDetailsElement>('[data-name-language]')!.open = true;
    expect(host.querySelectorAll('[data-name-language]')).toHaveLength(8);
    expect(host.querySelectorAll('[data-supplied-name]').length).toBeLessThanOrEqual(8 * 24);
    const termsAddress = new URL(host.querySelector('a')!.getAttribute('href')!, 'https://rezics.invalid');
    expect(termsAddress.pathname).toEndWith('/terms');
    expect(termsAddress.searchParams.get('realm')).toBe('00000000-0000-4000-8000-000000000777');
    expect(new URL(host.querySelectorAll('a')[1]!.getAttribute('href')!, 'https://rezics.invalid').searchParams.get('realm')).toBe('00000000-0000-4000-8000-000000000777');
    await click(button('More names'));
    expect(host.textContent).toContain('alias-39');
    await click(button('Next language groups'));
    await click(button('Next language groups'));
    expect(host.querySelector('[data-name-language="tr"]')).not.toBeNull();
    const input = host.querySelector('input')!;
    const setQuery = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await setQuery('Mél');
    expect(host.querySelectorAll('[data-supplied-name]')).toHaveLength(1);
    const copy = button('Copy');
    copy.focus();
    await click(copy);
    expect(copied).toBe('Exact—Mél/旅');
    expect(copy.parentElement?.textContent).toContain('Copied');
    write = async () => {
      throw new Error('clipboard refused');
    };
    await click(copy);
    expect(copy.parentElement?.textContent).toContain('Could not copy');
    expect(document.activeElement).toBe(copy);
    await setQuery('unmatched');
    expect(host.textContent).toContain('No supplied names match');
    await click(button('Clear filter'));
    expect(document.activeElement).toBe(input);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(reads).toBe(0);
    await act(async () =>
      client.setQueryData(['session'], { state: 'signed-in', subject: 'viewer', csrfToken: 'one' }),
    );
    expect(host.textContent).toContain('retired');
    const B = { ...A, public: structuredClone(A.public) };
    await draw(B);
    expect(reads).toBe(1);
    expect(host.textContent).toContain('advice is unavailable');
    expect(host.textContent).toContain('名・en');
    reply = async () => denied;
    await click(button('Retry Terms advice'));
    expect(reads).toBe(2);
    expect(host.textContent).toContain('does not allow');
    reply = async () => allowed;
    await draw(A);
    expect(host.textContent).toContain('retired');
    const C = { ...A, public: structuredClone(A.public) };
    await draw(C);
    expect(host.textContent).toContain('allows proposing');
    let finishCopy!: () => void;
    write = () =>
      new Promise<void>((resolve) => {
        finishCopy = resolve;
      });
    const retiredCopy = button('Copy');
    retiredCopy.focus();
    await click(retiredCopy);
    let finishAdvice!: (value: TermsPageAuthority) => void;
    reply = () =>
      new Promise((resolve) => {
        finishAdvice = resolve;
      });
    await draw({ ...A, public: structuredClone(A.public) });
    const oldAdvice = finishAdvice;
    reply = async () => denied;
    await draw({ ...A, public: structuredClone(A.public) });
    await act(async () => {
      finishCopy();
      oldAdvice(allowed);
    });
    expect(retiredCopy.isConnected).toBe(false);
    expect(host.textContent).toContain('does not allow');
    expect(host.textContent).not.toContain('Copied');
    expect(document.activeElement?.tagName).toBe('SUMMARY');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
