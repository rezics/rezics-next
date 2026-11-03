import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { act, type ReactNode } from 'react';
import { compile } from 'tailwindcss';
import { CollectionMemberList, CollectionSubjectList } from '../src/library/collection-editor';
import type { CollectionListPresentations } from '../src/library/collection-presentation';
import { subjectOf, type CollectionMember } from '../src/library/reads';
import recorded from '../src/kernel/recorded/library-collection-members.json';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { subjectHref } from '../src/subject/subject-href';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');

async function editorActionStyles() {
  const files = ['apps/web/src/library/collection-editor.tsx', 'packages/ui/src/shadcn/button.tsx'];
  const [sources, theme, preflight] = await Promise.all([
    Promise.all(files.map((path) => Bun.file(join(root, path)).text())),
    Bun.file(Bun.resolveSync('tailwindcss/theme.css', app)).text(),
    Bun.file(Bun.resolveSync('tailwindcss/preflight.css', app)).text(),
  ]);
  const compiler = await compile(`${theme}\n${preflight}\n@tailwind utilities;`);
  return compiler.build(sources.flatMap((source) => source.match(/[^\s"'`{}]+/g) ?? []));
}

function usedPx(value: string) {
  const px = Number.parseFloat(value);
  if (value.endsWith('px') && Number.isFinite(px)) return px;
  if (value.endsWith('rem') && Number.isFinite(px)) return px * 16;
  const steps = Number(/\*\s*(\d+)/.exec(value)?.[1]);
  expect(steps).toBeGreaterThan(0);
  return steps * 4;
}

function assertActionTarget(window: { getComputedStyle(element: Element): CSSStyleDeclaration }, element: HTMLElement) {
  expect(element.className).toContain('size-11');
  expect(element.className).toContain('md:pointer-fine:size-9');
  expect(element.className).not.toContain('sm:size-9');
  const style = window.getComputedStyle(element);
  expect(usedPx(style.width)).toBeGreaterThanOrEqual(44);
  expect(usedPx(style.height)).toBeGreaterThanOrEqual(44);
}

// UNRUN: composed assertions for integration; typing is not interaction, browser or native proof.
test('Shared Collection items preserve exact occurrence editing and independent controls', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.example/en', width: 1280 });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
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
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
  const title = '雪国';
  const subject = { ...subjectOf(recorded.members[0]!.subject)!, label: { value: title, language: 'ja' } };
  const landscape = { ...subjectOf(recorded.members[2]!.subject)!, type: 'schema:Movie', types: ['schema:Movie'] };
  const members: CollectionMember[] = [
    { ...recorded.members[0]!, subject, note: 'First occurrence' },
    { ...recorded.members[1]!, subject, note: 'Second occurrence' },
    { ...recorded.members[2]!, subject: landscape },
    { ...recorded.members[3]!, subject: null, note: 'Concealed note' },
  ];
  const presentations: CollectionListPresentations = {
    'schema:Book': { imageAspect: 'portrait', keyFacts: [] },
    'schema:Movie': { imageAspect: 'landscape', keyFacts: [] },
  };
  const selections: unknown[] = [];
  const notes: unknown[] = [];
  const moves: unknown[] = [];
  const copies: string[] = [];
  const boundaries: unknown[] = [];
  const removals: string[] = [];
  const destinations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor) {
      destinations.push(anchor.getAttribute('href')!);
      event.preventDefault();
    }
  });

  try {
    setLocale('en', { reload: false });
    await show(
      <CollectionMemberList
        members={members}
        editing
        firstPage
        selectedIds={new Set([members[1]!.id])}
        listPresentations={presentations}
        onSelectionChange={(...args) => selections.push(args)}
        onNoteChange={(...args) => notes.push(args)}
        onMove={(...args) => moves.push(args)}
        onCopy={(id) => {
          copies.push(id);
        }}
        onBoundaryMove={(...args) => boundaries.push(args)}
        onRemove={(id) => removals.push(id)}
      />,
    );
    const rows = [...host.querySelectorAll<HTMLElement>('[data-member]')];
    expect(rows.map((row) => row.getAttribute('data-member'))).toEqual(members.map(({ id }) => id));
    expect(rows[0]!.parentElement?.tagName).toBe('UL');
    const primary = rows[0]!.querySelector<HTMLAnchorElement>('h3[data-content-item-slot="title"] > a')!;
    const href = subjectHref({ id: subject.id, label: title }, 'en').href;
    expect(primary.textContent).toBe(title);
    expect(primary.getAttribute('lang')).toBe('ja');
    expect(primary.parentElement?.getAttribute('lang')).toBe('ja');
    expect(primary.closest('[aria-hidden="true"]')).toBeNull();
    expect(primary.getAttribute('href')).toBe(href);
    expect(rows[1]!.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(rows[3]!.querySelector('h3')?.textContent).toBe(m.library_subject_unavailable());
    expect(rows[3]!.querySelector('a, textarea, [data-collection-note-editor]')).toBeNull();
    expect(host.textContent).not.toContain('Concealed note');
    expect(rows[0]!.querySelector('[data-slot="cover"]')?.getAttribute('data-ratio')).toBe('5:7');
    expect(rows[2]!.querySelector('[data-slot="cover"]')?.getAttribute('data-ratio')).toBe('16:9');
    expect(rows[0]!.className).toContain('sm:grid-cols-[auto_96px_minmax(0,1fr)]');
    expect(rows[2]!.className).toContain('sm:grid-cols-[auto_192px_minmax(0,1fr)]');
    const selection = rows[1]!.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(selection.getAttribute('aria-checked')).toBe('true');
    const note = rows[1]!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(note.id).toBe(`collection-member-note-${members[1]!.id}`);
    expect(note.value).toBe('Second occurrence');
    for (const control of rows[1]!.querySelectorAll('button, textarea, summary, [data-drag-handle]')) {
      expect(control.closest('a')).toBeNull();
      expect(control.closest('[data-slot="list-row-control"]')).not.toBeNull();
    }
    const named = (row: HTMLElement, action: string, position: number) =>
      row.querySelector<HTMLButtonElement>(
        `button[aria-label="${action}: ${m.library_member_occurrence({ title, position })}"]`,
      )!;
    expect(named(rows[0]!, m.library_member_move_up(), 1).disabled).toBe(true);
    expect(
      rows[3]!.querySelector<HTMLButtonElement>(
        `button[aria-label="${m.library_member_move_down()}: ${m.library_member_occurrence({
          title: m.library_subject_unavailable(),
          position: 4,
        })}"]`,
      )!.disabled,
    ).toBe(true);
    const actionButtons = [
      ...rows[1]!.querySelectorAll<HTMLElement>('[data-content-item-slot="actions"] [data-slot="button"]'),
    ];
    expect(actionButtons).toHaveLength(4);
    const probe = new Window({ url: 'https://rezics.example/en', width: 700 });
    const sheet = probe.document.createElement('style');
    sheet.textContent = await editorActionStyles();
    probe.document.head.append(sheet);
    try {
      for (const action of actionButtons) {
        const button = probe.document.createElement('button');
        button.className = action.className;
        probe.document.body.append(button);
        assertActionTarget(probe, button);
      }
    } finally {
      await probe.happyDOM.close();
    }
    await act(async () => user.click(selection));
    await act(async () => user.click(rows[1]!.querySelector('summary')!));
    await act(async () => user.type(note, '!'));
    const context = m.library_member_occurrence({ title, position: 2 });
    const up = rows[1]!.querySelector<HTMLButtonElement>(
      `button[aria-label="${m.library_member_move_up()}: ${context}"]`,
    )!;
    await act(async () => user.click(up));
    const trigger = rows[1]!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const copy = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (item) => item.textContent === m.library_collection_copy(),
    )!;
    await act(async () => user.click(copy));
    await act(async () => user.click(trigger));
    const start = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (item) => item.textContent === m.library_collection_boundary_start(),
    )!;
    await act(async () => user.click(start));
    const remove = rows[1]!.querySelector<HTMLButtonElement>(
      `button[aria-label="${m.library_member_remove()}: ${context}"]`,
    )!;
    await act(async () => user.click(remove));
    expect(selections).toEqual([[members[1]!.id, false]]);
    expect(notes).toEqual([[members[1]!.id, 'Second occurrence!']]);
    expect(moves).toEqual([[members[1]!.id, null]]);
    expect(copies).toEqual([members[1]!.id]);
    expect(boundaries).toEqual([[members[1]!.id, 'start']]);
    expect(removals).toEqual([members[1]!.id]);
    expect(destinations).toEqual([]);
    await act(async () => user.click(primary));
    expect(destinations).toEqual([href]);

    await show(
      <CollectionMemberList
        members={members}
        editing={false}
        firstPage
        listPresentations={presentations}
        onCopy={(id) => {
          copies.push(id);
        }}
      />,
    );
    expect(host.querySelector('[data-slot="collection-member-note"]')?.textContent).toBe('First occurrence');
    expect(host.querySelector('textarea, [role="checkbox"], [data-drag-handle]')).toBeNull();
    expect(host.querySelector('button[aria-haspopup="menu"]')?.closest('a')).toBeNull();

    await show(
      <CollectionSubjectList
        subjects={[subject, null]}
        onCopy={(item) => {
          copies.push(item.id);
        }}
        listPresentations={presentations}
      />,
    );
    const subjects = host.querySelectorAll('li');
    expect(subjects[0]!.querySelector('h3 > a')?.getAttribute('href')).toBe(href);
    expect(subjects[0]!.querySelector('h3')?.getAttribute('lang')).toBe('ja');
    expect(subjects[0]!.querySelector('[data-slot="cover"]')?.getAttribute('data-ratio')).toBe('5:7');
    expect(subjects[1]!.querySelector('h3')?.textContent).toBe(m.library_subject_unavailable());
    expect(subjects[1]!.querySelector('a, button')).toBeNull();
    const subjectProbe = new Window({ url: 'https://rezics.example/en', width: 700 });
    const subjectSheet = subjectProbe.document.createElement('style');
    subjectSheet.textContent = await editorActionStyles();
    subjectProbe.document.head.append(subjectSheet);
    try {
      const button = subjectProbe.document.createElement('button');
      button.className = subjects[0]!.querySelector<HTMLElement>('[data-slot="button"]')!.className;
      subjectProbe.document.body.append(button);
      assertActionTarget(subjectProbe, button);
    } finally {
      await subjectProbe.happyDOM.close();
    }
  } finally {
    await act(async () => root.unmount());
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
