import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { m } from '../src/paraglide/messages.js';
import type { CollectionReadMember } from '../src/library/collection-member-details';
import type { CollectionMember } from '../src/library/reads';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { collectionPageAddress } from '../src/library/collection-presentation';
import { collectionMemberReturnAddress } from '../src/subject/collection-return';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const search = { type: 'work', 'f.genre': 'fiction', 'l.genre': 'Fiction' };
const directoryReturn = '/en/library/collections?cursor=directory-next&layout=previews';
const address = (layout: 'list' | 'grid', cursor = 'next+/=') => {
  const route = new URL(collectionPageAddress('en', id(1), cursor, search, layout), 'https://rezics.invalid');
  route.searchParams.set('returnTo', directoryReturn);
  return `${route.pathname}${route.search}`;
};
const note = `  Supplied note\n\n\t${'界'.repeat(600)}\n `;
const members: CollectionMember[] = [2, 3].map((n) => ({
  id: id(n),
  addedAt: '2026-11-01T00:00:00Z',
  note: n === 2 ? note : 'Second occurrence note',
  subject: { id: id(4), type: 'work', types: ['work'], label: 'Identical title', typeLabel: 'Book', cover: null },
  facts: {
    creator: [10, 11, 12].map((n) => ({ kind: 'item', id: id(n), labels: { en: 'Same name' } })),
    date: [1943, 1944, 1945].map((year) => ({ kind: 'time', year })),
    code: ['FIRST', 'SECOND', 'THIRD'].map((value) => ({ kind: 'code', value })),
    quantity: [90, 91, 92].map((amount) => ({ kind: 'quantity', amount, unit: 'min' })),
  },
}));
const presentations = { work: { imageAspect: 'portrait' as const, keyFacts: ['creator', 'date', 'code', 'quantity'] } };

for (const layout of ['list', 'grid'] as const) {
  test(`${layout}: one exact occurrence detail retains all evidence, independent reference targets and local copy outcomes`, async () => {
    const { Window } = await import(
      Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
    );
    const currentHref = address(layout);
    const alternateLayout = layout === 'list' ? 'grid' : 'list';
    const window = new Window({ url: `https://rezics.test${currentHref}`, width: 390 });
    const globals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, value });
    const copied: string[] = [];
    let failCopy = false;
    let finishCopy: (() => void) | undefined;
    let delayCopy = false;
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(value: string) {
          copied.push(value);
          if (failCopy) throw new Error('Clipboard permission denied');
          if (delayCopy)
            await new Promise<void>((resolve) => {
              finishCopy = resolve;
            });
        },
      },
    });
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('main');
    window.document.body.append(host);
    const root = createRoot(host);
    const source = {};
    const render = (
      rows: readonly CollectionReadMember[] = members,
      href = currentHref,
      returnSource = source,
      view: 'list' | 'grid' = layout,
    ) =>
      act(async () =>
        root.render(
          createElement(CollectionReadMembers, {
            members: rows,
            layout: view,
            currentHref: href,
            returnSource,
            listPresentations: presentations,
            comparisonDefinitions: { creator: { labels: { en: 'Full supplied property label' } } },
            onCopy: async (member) => {
              copied.push(member.subject!.id);
            },
          }),
        ),
      );
    const openers = () => [...host.querySelectorAll<HTMLButtonElement>('[data-collection-detail-opener]')];
    const detail = () => host.querySelector<HTMLElement>('[data-slot="member-reading-detail"]');
    const open = async (index: number) => {
      const opener = openers()[index]!;
      opener.focus();
      await act(async () => opener.click());
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      expect(window.document.activeElement).toBe(detail());
      return opener;
    };
    const close = async () => act(async () => detail()!.querySelector<HTMLButtonElement>('button')!.click());
    try {
      await render();
      expect(host.querySelector('[data-slot="collection-member-note"]')).toBeNull();
      expect(host.querySelector('[data-slot="cover-card-actions-row"]')).toBeNull();
      expect(host.querySelectorAll('section[aria-label="Members"]')).toHaveLength(1);
      expect(openers()).toHaveLength(2);
      expect(host.querySelectorAll(layout === 'list' ? 'ul > li' : '[role="listitem"]')).toHaveLength(2);
      const first = await open(0);
      expect(detail()!.querySelector('[data-slot="collection-member-note"]')!.textContent).toBe(note);
      expect(detail()!.querySelectorAll('dl > div')).toHaveLength(12);
      for (const value of ['1945', 'THIRD', '92 min', 'Full supplied property label'])
        expect(detail()!.textContent).toContain(value);
      const references = [...detail()!.querySelectorAll<HTMLAnchorElement>('[data-comparison-reference]')];
      expect(references).toHaveLength(3);
      expect(new Set(references.map((link) => link.href)).size).toBe(3);
      for (const [index, link] of references.entries()) {
        expect(link.textContent).toBe('Same name');
        const url = new URL(link.href);
        expect(url.pathname).toContain(id(10 + index));
        const viaAddress = url.searchParams.get('via')!;
        const via = new URL(viaAddress, 'https://rezics.test');
        expect(via.pathname).toBe(`/en/collections/${id(1)}`);
        expect(via.searchParams.get('cursor')).toBe('next+/=');
        expect(via.searchParams.get('type')).toBe('work');
        expect(via.searchParams.getAll('f.genre')).toEqual(['fiction']);
        expect(via.searchParams.getAll('l.genre')).toEqual(['Fiction']);
        expect(via.searchParams.get('layout')).toBe(layout === 'grid' ? 'grid' : null);
        expect(via.searchParams.get('layout') ?? 'list').toBe(layout);
        expect(viaAddress).toBe(collectionMemberReturnAddress(currentHref, id(2)));
        expect(via.searchParams.get('returnTo')).toBe(directoryReturn);
        expect(via.hash).toBe(`#collection-member-${id(2)}`);
        expect(subjectVisitReturn(viaAddress, 'en')).toBe(viaAddress);
        const copy = detail()!.querySelector<HTMLButtonElement>(`[data-copy-reference="${id(10 + index)}"]`)!;
        await act(async () => copy.click());
        expect(copied.at(-1)).toBe(link.href);
        expect(copy.parentElement!.textContent).toContain(m.collection_reading_copy_done());
      }
      failCopy = true;
      const denied = detail()!.querySelector<HTMLButtonElement>(`[data-copy-reference="${id(10)}"]`)!;
      await act(async () => denied.click());
      expect(denied.parentElement!.textContent).toContain(m.collection_reading_copy_unavailable());
      failCopy = false;
      expect(host.querySelectorAll('a a, a button')).toHaveLength(0);
      await close();
      expect(detail()).toBeNull();
      expect(window.document.activeElement).toBe(first);
      const second = await open(1);
      expect(host.querySelectorAll('[data-slot="member-reading-detail"]')).toHaveLength(1);
      expect(detail()!.textContent).toContain('Second occurrence note');
      expect(detail()!.textContent).not.toContain(note);
      await act(async () =>
        detail()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(window.document.activeElement).toBe(second);

      // Address, native observation and layout replacement retire detail without restoring stale opener focus.
      for (const replace of [
        () => render(members, address(layout, 'other-cursor')),
        () => render(members, currentHref, {}),
        () => render(members.map((member) => ({ ...member }))),
        () => render(members, address(alternateLayout), source, alternateLayout),
      ]) {
        await render();
        const opener = await open(0);
        await replace();
        expect(detail()).toBeNull();
        expect(window.document.activeElement).not.toBe(opener);
      }
      // A clipboard completion belongs to the retired detail only.
      await render();
      await open(0);
      delayCopy = true;
      await act(async () => detail()!.querySelector<HTMLButtonElement>('[data-copy-reference]')!.click());
      expect(detail()!.textContent).toContain(m.collection_reading_copy_pending());
      await render(members, currentHref, {});
      await act(async () => finishCopy!());
      expect(detail()).toBeNull();
      expect(host.textContent).not.toContain(m.collection_reading_copy_done());
      const projections = members.map(({ subject, facts }) => ({ subject, facts }));
      await render(projections);
      expect(host.querySelector('[data-collection-member-id]')).toBeNull();
      await open(1);
      const projectionLink = detail()!.querySelector<HTMLAnchorElement>('[data-comparison-reference]')!;
      const projectionViaAddress = new URL(projectionLink.href).searchParams.get('via')!;
      expect(projectionViaAddress).toBe(collectionMemberReturnAddress(currentHref));
      const projectionVia = new URL(projectionViaAddress, 'https://rezics.test');
      expect(projectionVia.searchParams.get('returnTo')).toBe(directoryReturn);
      expect(projectionVia.hash).toBe('');
      expect(detail()!.querySelector('[data-slot="collection-member-note"]')).toBeNull();

      const returnHost = window.document.createElement('main');
      window.document.body.append(returnHost);
      const returnRoot = createRoot(returnHost);
      const returnAddress = new URL(references[0]!.href).searchParams.get('via')!;
      (window.document.activeElement as HTMLElement).blur();
      await act(async () => root.render(null));
      window.history.pushState({}, '', returnAddress);
      await act(async () =>
        returnRoot.render(
          createElement(CollectionReadMembers, {
            members,
            layout,
            currentHref: returnAddress,
            returnSource: {},
            listPresentations: presentations,
            comparisonDefinitions: { creator: { labels: { en: 'Full supplied property label' } } },
            onCopy() {},
          }),
        ),
      );
      expect(window.document.activeElement).toBe(returnHost.querySelector(`#collection-member-${id(2)}`));
      await act(async () => returnRoot.unmount());

      await render([{ ...members[0]!, subject: null }]);
      await open(0);
      expect(detail()!.querySelector('a,[data-copy-reference]')).toBeNull();
      expect(detail()!.textContent).toContain(note);
    } finally {
      await act(async () => root.unmount());
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
afterAll(() => mock.restore());
