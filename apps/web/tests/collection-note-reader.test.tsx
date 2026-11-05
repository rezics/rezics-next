import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import recorded from '../src/kernel/recorded/library-collection-members.json';
import { CollectionMemberList } from '../src/library/collection-editor';
import { subjectOf, type CollectionMember } from '../src/library/reads';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { subjectHref } from '../src/subject/subject-href';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.example' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

// UNRUN: focused composed outcomes; browser geometry is covered by the dedicated, also unrun stories.
for (const presentation of ['occurrence list', 'member list', 'grid'] as const) {
  test(`${presentation}: bounded exact notes have independent occurrence and keyboard disclosure`, async () => {
    const { Window } = await import(
      Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
    );
    const window = new Window({ url: 'https://rezics.example/en', width: 390 });
    window.document.documentElement.lang = 'en';
    let narrow = true;
    // happy-dom has no text layout. Supply overflowing and short geometry; browser stories use real layout.
    Object.defineProperties(window.HTMLElement.prototype, {
      clientHeight: {
        configurable: true,
        get() {
          return this.classList.contains('line-clamp-2') ? 48 : this.classList.contains('line-clamp-4') ? 96 : 144;
        },
      },
      scrollHeight: {
        configurable: true,
        get() {
          return narrow && (this.textContent?.length ?? 0) > 120 ? 144 : 24;
        },
      },
    });
    const resizeCallbacks = new Set<() => void>();
    class LayoutObserver {
      constructor(private callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    }
    const globals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      Element: window.Element,
      Node: window.Node,
      Document: window.Document,
      ShadowRoot: window.ShadowRoot,
      DocumentFragment: window.DocumentFragment,
      MutationObserver: window.MutationObserver,
      ResizeObserver: LayoutObserver,
      Event: window.Event,
      NodeFilter: window.NodeFilter,
      KeyboardEvent: window.KeyboardEvent,
      FocusEvent: window.FocusEvent,
      MouseEvent: window.MouseEvent,
      PointerEvent: window.PointerEvent,
      CSS: window.CSS,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const require = createRequire(import.meta.url);
    const storybook = createRequire(require.resolve('storybook/test'));
    const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
    const user = userEvent.setup({ document: window.document });
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    const show = (node: ReactNode) => act(async () => root.render(node));
    const previousLocale = getLocale();
    const subject = { ...subjectOf(recorded.members[0]!.subject)!, label: 'Repeated subject', cover: null };
    const firstNote = `  First occurrence\n\n\t${'Exact spaces and lines.  '.repeat(18)}\n `;
    const secondNote = `Second occurrence\n${'A different note. '.repeat(20)}`;
    const unbroken = '界'.repeat(600);
    const members: CollectionMember[] = [
      firstNote,
      secondNote,
      'Short note',
      null,
      '',
      'Concealed note',
      unbroken,
      ' \t\n ',
    ].map((note, index) => ({
      id: `occurrence-${index}`,
      subject: index === 5 ? null : subject,
      note,
      addedAt: recorded.members[0]!.addedAt,
    }));
    const copies: unknown[] = [];
    const destinations: string[] = [];
    host.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (anchor) {
        destinations.push(anchor.getAttribute('href')!);
        event.preventDefault();
      }
    });
    const render = (items: CollectionMember[]) =>
      presentation === 'occurrence list' ? (
        <CollectionMemberList
          members={items}
          editing={false}
          firstPage
          onCopy={(id) => {
            copies.push(id);
          }}
        />
      ) : (
        <CollectionReadMembers
          members={items}
          layout={presentation === 'grid' ? 'grid' : 'list'}
          onCopy={(item) => {
            copies.push(item);
          }}
        />
      );
    const notes = () => [...host.querySelectorAll<HTMLParagraphElement>('[data-slot="collection-member-note"]')];
    const controlFor = (text: HTMLParagraphElement) => text.parentElement!.querySelector<HTMLButtonElement>('button')!;

    try {
      setLocale('en', { reload: false });
      await show(render(members));
      const texts = notes();
      expect(texts.map((text) => text.textContent)).toEqual([firstNote, secondNote, 'Short note', unbroken, ' \t\n ']);
      const clamp = presentation === 'grid' ? 'line-clamp-4' : 'line-clamp-2';
      expect(texts.every((text) => text.classList.contains(clamp))).toBe(true);
      for (const text of texts) {
        expect(text.className).toContain('whitespace-pre-wrap');
        expect(text.className).toContain('[overflow-wrap:anywhere]');
        expect(text.closest('[data-slot="list-row-control"]')).not.toBeNull();
      }
      expect(controlFor(texts[2]!)).toBeNull();
      expect(controlFor(texts[4]!)).toBeNull();
      expect(host.textContent).not.toContain('Concealed note');
      expect(host.querySelector('textarea, [role="checkbox"], [data-drag-handle]')).toBeNull();
      expect(host.querySelectorAll('a a, a button')).toHaveLength(0);
      const first = controlFor(texts[0]!);
      const second = controlFor(texts[1]!);
      const context = m.library_member_occurrence({ title: 'Repeated subject', position: 1 });
      expect(first.getAttribute('aria-label')).toBe(`${m.library_collection_note_reader_expand()}: ${context}`);
      expect(second.getAttribute('aria-label')).not.toBe(first.getAttribute('aria-label'));
      expect(first.getAttribute('aria-controls')).toBe(texts[0]!.id);
      expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));
      expect(first.closest('a')).toBeNull();

      first.focus();
      await act(async () => user.keyboard('{Enter}'));
      expect(first.getAttribute('aria-expanded')).toBe('true');
      expect(second.getAttribute('aria-expanded')).toBe('false');
      expect(first.getAttribute('aria-label')).toBe(`${m.library_collection_note_reader_collapse()}: ${context}`);
      expect(texts[0]!.classList.contains(clamp)).toBe(false);
      expect(texts[0]!.textContent).toBe(firstNote);
      expect(window.document.activeElement).toBe(first);
      narrow = false;
      await act(async () => resizeCallbacks.forEach((resize) => resize()));
      expect(controlFor(texts[0]!)).toBe(first);
      expect(first.getAttribute('aria-expanded')).toBe('true');
      narrow = true;
      await act(async () => resizeCallbacks.forEach((resize) => resize()));
      await act(async () => user.keyboard(' '));
      expect(first.getAttribute('aria-expanded')).toBe('false');
      expect(window.document.activeElement).toBe(first);
      await act(async () => user.tab({ shift: true }));
      expect(window.document.activeElement).not.toBe(first);
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(first);
      await act(async () => user.keyboard('{Enter}'));

      await show(render([members[1]!, members[0]!, ...members.slice(2)]));
      expect(notes()[0]!.textContent).toBe(secondNote);
      expect(controlFor(notes()[0]!).getAttribute('aria-expanded')).toBe('false');
      expect(controlFor(notes()[1]!)).toBe(first);
      expect(first.getAttribute('aria-expanded')).toBe('true');
      expect(first.getAttribute('aria-label')).toContain(
        m.library_member_occurrence({ title: 'Repeated subject', position: 2 }),
      );
      await act(async () => user.click(controlFor(notes()[3]!)));
      expect(notes()[3]!.textContent).toBe(unbroken);
      expect(notes()[3]!.classList.contains(clamp)).toBe(false);
      expect(destinations).toEqual([]);
      expect(copies).toEqual([]);
      const href = subjectHref({ id: subject.id, label: 'Repeated subject' }, 'en').href;
      expect(host.querySelectorAll('a')).toHaveLength(7);
      expect([...host.querySelectorAll('a')].every((link) => link.getAttribute('href') === href)).toBe(true);
      await act(async () => user.click(host.querySelector('a')!));
      expect(destinations).toEqual([href]);

      // Replacement records cannot inherit another occurrence's expanded state.
      await show(render([{ ...members[0]!, id: 'replacement', note: secondNote }]));
      expect(controlFor(notes()[0]!).getAttribute('aria-expanded')).toBe('false');
      await act(async () => user.click(controlFor(notes()[0]!)));
      // Retired disclosure removes the note and control even when the occurrence id is unchanged.
      await show(render([{ ...members[0]!, id: 'replacement', subject: null, note: secondNote }]));
      expect(notes()).toHaveLength(0);
      expect(host.querySelector('a, button, [data-collection-note-reader]')).toBeNull();
      expect(host.textContent).toContain(m.library_subject_unavailable());
      await show(render([]));
      expect(host.querySelector('[data-collection-note-reader]')).toBeNull();
      await show(render([members[0]!]));
      expect(controlFor(notes()[0]!).getAttribute('aria-expanded')).toBe('false');
      const retained = controlFor(notes()[0]!);
      retained.focus();
      narrow = false;
      await act(async () => resizeCallbacks.forEach((resize) => resize()));
      expect(controlFor(notes()[0]!)).toBe(retained);
      expect(window.document.activeElement).toBe(retained);
      await act(async () => user.tab({ shift: true }));
      expect(controlFor(notes()[0]!)).toBeNull();
      narrow = true;
      await act(async () => resizeCallbacks.forEach((resize) => resize()));
      expect(controlFor(notes()[0]!)).not.toBeNull();
      if (presentation !== 'occurrence list') {
        // Id-less supplied read rows must not carry expansion by their old array position.
        const idless = (note: string) => (
          <CollectionReadMembers
            members={[{ subject, note }]}
            layout={presentation === 'grid' ? 'grid' : 'list'}
            onCopy={() => undefined}
          />
        );
        await show(idless(firstNote));
        await act(async () => user.click(controlFor(notes()[0]!)));
        await show(idless(secondNote));
        expect(notes()[0]!.textContent).toBe(secondNote);
        expect(controlFor(notes()[0]!).getAttribute('aria-expanded')).toBe('false');
      }
    } finally {
      await act(async () => root.unmount());
      expect(resizeCallbacks.size).toBe(0);
      setLocale(previousLocale, { reload: false });
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    }
  });
}
