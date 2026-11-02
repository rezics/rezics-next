import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { stageFact, type FactDraft, type FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Generic and Manga discard retains cancelled assertions and siblings, releases slots and respects command locks', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const keys =
    'window document navigator HTMLElement HTMLInputElement HTMLSelectElement Element Node DocumentFragment MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key];
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: typeof value === 'function' && key[0] === key[0]!.toLowerCase() ? value.bind(window) : value,
    });
  }
  const { createRoot } = await import('react-dom/client');
  const { SubjectFacts, FactField } = await import('../src/features/catalogue/subject-facts-view');
  const { MangaCorrections } = await import('../src/features/catalogue/manga-profile-corrections');
  const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = (node: ReactNode) => act(async () => root.render(node));
  const click = (node: HTMLElement) => act(async () => node.click());
  const button = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => !node.hidden && node.textContent?.trim() === text,
    )!;
  const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  const enter = (row: HTMLElement, value: string) =>
    act(async () => {
      const input = row.querySelector<HTMLInputElement>('input')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const field = (property: string) =>
    [...host.querySelectorAll<HTMLElement>('section[aria-label]')].find(
      (node) => node.getAttribute('aria-label') === property,
    )!;
  const values = (scope: HTMLElement) =>
    [...scope.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value);
  try {
    for (const manga of [false, true]) {
      const ready = await readMangaProfile(mangaFixture().client, mangaVolumeId);
      if (!ready.ok || !ready.public) throw new Error('Expected Manga fixture');
      const read = { ...ready, public: ready.public, source: null };
      const property = 'schema:numberOfPages';
      const source = read.public.subject.statements[property]![0]!;
      const second = { ...structuredClone(source), id: crypto.randomUUID() };
      read.public.subject.statements[property]!.push(second);
      read.release.properties[property]!.multivalued = true;
      const properties = manga
        ? [property, 'schema:isbn']
        : [property, ...Array.from({ length: 12 }, (_, i) => `test:field${i}`)];
      for (const id of properties) {
        read.release.properties[id] ??= structuredClone(read.release.properties['schema:isbn']!);
        read.release.properties[id]!.labels = { en: id };
      }
      if (!manga) read.release.types[read.public.subject.type]!.properties = properties;
      let requests = 0;
      let resolve!: (result: FactResult) => void;
      const facts = {
        read: async () => read,
        propose: () => {
          requests++;
          return new Promise<FactResult>((yes) => {
            resolve = yes;
          });
        },
      };
      const review = () => {
        throw new Error('Discard must not open review');
      };
      const node = manga
        ? h(MangaCorrections, {
            read,
            locale: 'en',
            disabled: false,
            reload: async () => {},
            ports: { facts, review, relations: null, authored: null },
          })
        : h(SubjectFacts, { initial: read, locale: 'en', transport: facts, review });
      await render(h('div', { key: String(manga) }, node));
      const row = field(property);
      await choose(row.querySelector('select')!, source.id);
      await click(button(row, 'Edit this field'));
      await enter(row, '+240');
      for (const id of properties.slice(1, manga ? 2 : 12)) await click(button(field(id), 'Edit this field'));
      const sibling = values(field(properties[1]!));
      const entered = values(row);
      const action = `Remove draft for ${property}`;
      if (!manga) expect(button(field(properties[12]!), 'Edit this field').disabled).toBe(true);
      await click(button(row, action));
      expect(window.document.activeElement?.textContent).toBe('Cancel');
      await click(button(row, 'Cancel'));
      expect(values(row)).toEqual(entered);
      expect(window.document.activeElement).toBe(button(row, action));
      await click(button(row, action));
      await act(async () =>
        button(row, 'Cancel').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(button(row, 'Cancel')).toBeUndefined();
      expect(values(row)).toEqual(entered);
      await click(button(row, action));
      await click(button(row, action));
      expect(row.querySelector('select')?.value).toBe(source.id);
      expect(window.document.activeElement).toBe(row.querySelector('select'));
      expect(values(field(properties[1]!))).toEqual(sibling);
      expect(requests).toBe(0);
      if (!manga) expect(button(field(properties[12]!), 'Edit this field').disabled).toBe(false);
      await choose(row.querySelector('select')!, second.id);
      await click(button(row, 'Edit this field'));
      expect(row.textContent).toContain('Selected value 2');
      await enter(row, '+241');
      await click(button(row, action));
      await act(async () =>
        host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(button(row, action).disabled).toBe(true);
      await act(async () => resolve({ ok: false, reason: 'uncertain' }));
      expect(button(row, action).disabled).toBe(true);
    }
    const ready = await readMangaProfile(mangaFixture().client, mangaVolumeId);
    if (!ready.ok || !ready.public) throw new Error('Expected fixture');
    const read = { ...ready, public: ready.public, source: null };
    const property = 'schema:isbn';
    const draft = stageFact(read, property, read.public.subject.statements[property]![0]!.id)!;
    let removed = 0;
    const noop = () => {};
    const common = {
      property,
      read,
      locale: 'en',
      canStage: true,
      href: '/',
      onStage: noop,
      onChange: noop,
      onReview: noop,
      onDiscard: () => {
        removed++;
      },
    };
    const show = (draft: FactDraft, busy = false) => render(h(FactField, { ...common, draft, busy }));
    await show(draft);
    const action = `Remove draft for ${read.release.properties[property]!.labels.en}`;
    await click(button(host, action));
    await show({ ...draft });
    expect(button(host, 'Cancel')).toBeUndefined();
    for (const locked of [
      {
        ...draft,
        command: { id: mangaVolumeId, key: 'sealed', statement: draft.statement },
        result: { ok: false as const, reason: 'stale' as const },
      },
      ...(['uncertain', 'unavailable'] as const).map((reason) => ({
        ...draft,
        result: { ok: false as const, reason },
      })),
    ]) {
      await show(locked);
      expect(button(host, action).disabled).toBe(true);
    }
    await show(draft, true);
    expect(button(host, action).disabled).toBe(true);
    expect(removed).toBe(0);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
