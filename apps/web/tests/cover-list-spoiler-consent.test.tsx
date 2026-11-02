import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { Item } from '../src/features/pages/overview';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

test('relation consent follows accepted content in cards and qualified credits', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/subject' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CoverList } = await import('../src/features/pages/cover-list');
  type Props = ComponentProps<typeof CoverList>;
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const value: Props['value'] = {
    subject: 'subject',
    locale: 'en',
    reader: { spoilerLevel: 0, suitability: 'blur' },
    link: ({ children, ...props }) => <a {...props}>{children}</a>,
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal relation',
    labels: {
      spoilerShow: 'Reveal relation',
      spoilerHide: 'Conceal relation',
      documentSpoiler: 'Reveal passage',
      cover: { withheld: '', reveal: '', credit: '', via: '' },
    },
  };
  const show = (items: Item[], overrides: Partial<Props> = {}) =>
    act(async () => root.render(<CoverList items={items} value={value} label="Relations" {...overrides} />));
  const rows = () => [...host.querySelectorAll('[data-statement]')];
  const open = (row: Element) => act(async () => (row.querySelector('button') as HTMLButtonElement).click());
  const revealed = () => rows().map((row) => row.querySelector('button')?.getAttribute('aria-expanded') === 'true');
  try {
    for (const credit of [false, true]) {
      const first: Item = {
        id: 'target',
        statement: 'first',
        label: { text: 'Hidden target', lang: 'en' },
        notes: ['First role'],
        gated: true,
        ...(credit
          ? { qualified: [{ text: 'Hidden character', subject: { id: 'character', label: 'Character' } }] }
          : {}),
      };
      const second = { ...first, statement: 'second', notes: ['Second role'] };
      await show([]);
      await show([first, second]);
      expect(host.querySelector('a')).toBeNull();
      await open(rows()[0]!);
      expect(revealed()).toEqual([true, false]);
      expect(rows()[0]!.textContent).toContain('Conceal relation');
      await show(structuredClone([first, second]));
      expect(revealed()).toEqual([true, false]);
      await show([second, first]);
      expect(revealed()).toEqual([false, true]);
      await show([second, { ...first, statement: 'replacement' }]);
      expect(revealed()).toEqual([false, false]);
      // A delivered same-ID revision must retire the old reveal permanently, including when it returns.
      for (const revised of [
        { ...first, label: { text: 'Revised target', lang: 'en' } },
        { ...first, notes: ['Revised role'] },
        { ...first, qualified: [{ text: 'Revised character' }] },
        { ...first, summary: { id: 'target', type: 'schema:Movie' } },
      ]) {
        await show([first]);
        await open(rows()[0]!);
        await show([revised]);
        expect(revealed()).toEqual([false]);
        await show([first]);
        expect(revealed()).toEqual([false]);
      }
      for (const changed of [
        { ...value, subject: 'another-subject' },
        { ...value, context: { id: 'context', population: { kind: 'global' as const } } },
        { ...value, context: { id: 'context', population: { kind: 'realm' as const, id: 'realm', title: 'Realm' } } },
        { ...value, reader: { ...value.reader, spoilerLevel: 1 as const } },
        { ...value, reader: { ...value.reader, suitability: 'show' as const } },
      ]) {
        await open(rows()[0]!);
        await show([first], { value: changed });
        expect(revealed()).toEqual([false]);
        await show([first]);
        expect(revealed()).toEqual([false]);
      }
      await show([{ ...first, gated: false }]);
      await show([first, first]);
      await open(rows()[0]!);
      expect(revealed()).toEqual([true, false]);
      await show(structuredClone([first, first]));
      expect(revealed()).toEqual([true, false]);
      await show([first]);
      await show([{ ...first, gated: false }]);
      await show([first]);
      expect(revealed()).toEqual([false]);
      const facts = { target: { 'schema:datePublished': [{ kind: 'time' as const, year: 2000 }] } };
      const presentation = () => ({ imageAspect: 'portrait' as const, keyFacts: ['schema:datePublished'] });
      await show([first], { memberFacts: facts, listPresentationFor: presentation });
      await open(rows()[0]!);
      await show([first], { memberFacts: structuredClone(facts), listPresentationFor: () => presentation() });
      expect(revealed()).toEqual([true]);
      await show([first], {
        memberFacts: { target: { 'schema:datePublished': [{ kind: 'time', year: 2001 }] } },
        listPresentationFor: presentation,
      });
      expect(revealed()).toEqual([false]);
    }
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
