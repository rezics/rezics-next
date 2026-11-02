import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { LabelShelfEntry } from '../src/library/label-shelf-read';
import * as start from '../.storybook/react-start';

// Authored outcome cases for controller verification; deliberately UNRUN in this source delivery.
// Keep the real table, menu and native form. Substitute only operation admission and server bindings.
test('Label-shelf table respects supported selected columns, assignment identity, exact removal operands and honest unavailable facts', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const exposure = await import('../src/kernel/exposure');
  let admitted = true;
  const admission = spyOn(exposure, 'useOperation').mockImplementation(
    (operation) => operation === 'library_label.unassign' && admitted,
  );
  const { LabelShelfEntries } = await import('../src/library/shelf-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { createRoot } = await import('react-dom/client');
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const label = { id: id(800), name: 'My private reading list' };
  const subject: NonNullable<LabelShelfEntry['subject']> = {
    id: id(1100),
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: '日本語の長い題名', language: 'ja' },
    typeLabel: 'Book',
    cover: {
      media: id(3000),
      width: 400,
      height: 600,
      placeholder: { thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j3A', color: '#445566' },
      variants: [{ format: 'webp', width: 400 }],
      focalPoint: null,
      credit: null,
    },
  };
  const entries: LabelShelfEntry[] = [
    {
      id: id(1202), labelId: label.id, subjectId: id(1101), revision: 9, removeKey: id(2202), subject,
      state: 'in_progress', stateLabel: 'Recorded state',
      activeProgressSession: {
        mode: 'scalar_amount', unit: 'percent', dimension: 'percent', amount: '0', total: null,
        completedUnitCount: 0, locator: null,
      },
    },
    {
      id: id(1201), labelId: label.id, subjectId: id(1101), revision: 3, removeKey: id(2201), subject,
      activeProgressSession: {
        mode: 'cursor_position', unit: 'page', amount: null, total: null,
        completedUnitCount: 0, locator: 'Recorded location', position: null,
      },
    },
    { id: id(1203), labelId: label.id, subjectId: id(1199), revision: 5, removeKey: id(2203), subject: null },
  ];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let current = true;
  let mountKey = 0;
  let selection: string | undefined;
  const render = async (rows = entries) => {
    await act(async () => {
      root.render(createElement(LabelShelfEntries, {
        key: mountKey, entries: rows, label, locale: 'en', layout: 'table', size: 'm',
        ...(selection ? { columns: selection } : {}), csrfToken: 'original-csrf', isCurrent: () => current,
      }));
    });
  };
  const headers = () => [...host.querySelectorAll('th')].map((node) => node.textContent);
  const rows = () => [...host.querySelectorAll('tbody tr')];
  const triggers = () => [...host.querySelectorAll<HTMLButtonElement>('tbody button[aria-label]')];
  const open = async (index: number) => {
    await act(async () => {
      triggers()[index]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return window.document.querySelector<HTMLFormElement>('form[method="post"]')!;
  };
  const fields = (form: HTMLFormElement) => Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[name]')].map((input) => [input.name, input.value]),
  );
  try {
    // Default supported facts: one table, no date/sort promises, zero distinct from unknown progress.
    await render();
    expect(host.querySelectorAll('table')).toHaveLength(1);
    expect(headers()).toEqual([
      m.library_column_cover(), m.library_column_title(), m.library_column_type(), m.library_label_table_status_progress(),
    ]);
    expect(host.querySelector('thead button, th[aria-sort], time')).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.querySelector('img')?.getAttribute('src')).toBe(`/media/${id(3000)}/webp-400`);
    expect(rows()[0]!.textContent).toContain('0%');
    expect(rows()[0]!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(rows()[1]!.textContent).toContain('Recorded location');
    expect(rows()[1]!.querySelector('[role="progressbar"]')).toBeNull();
    expect(rows()[1]!.textContent).not.toContain(m.library_other());
    expect(rows()[2]!.querySelector('[data-slot="tombstone"]')).not.toBeNull();
    expect(rows()[2]!.querySelector('a')).toBeNull();
    expect(host.textContent).not.toContain(id(1199));
    const links = [...host.querySelectorAll<HTMLAnchorElement>('tbody a')];
    const title = '日本語の長い題名';
    expect(links.map((link) => link.textContent)).toEqual([title, title]);
    expect(links.map((link) => link.getAttribute('lang'))).toEqual(['ja', 'ja']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(Array(2).fill(
      subjectHref({ id: subject.id, label: title }, 'en').href,
    ));

    // Hidden facts stay hidden even though the independent action cell remains reachable.
    for (const [columns, expected] of [
      ['title', [m.library_column_title(), m.library_column_actions()]],
      ['title,type', [m.library_column_title(), m.library_column_type(), m.library_column_actions()]],
      ['title,added,finished,lastActivity', [m.library_column_title(), m.library_column_actions()]],
      ['cover,title,status', [m.library_column_cover(), m.library_column_title(), m.library_label_table_status_progress()]],
    ] as const) {
      selection = columns;
      await render();
      expect(headers()).toEqual([...expected]);
      expect(rows()).toHaveLength(entries.length);
      expect(triggers()).toHaveLength(entries.length);
      if (!columns.includes('status')) {
        expect(host.textContent).not.toContain('Recorded state');
        expect(host.textContent).not.toContain('Recorded location');
        expect(host.querySelector('[data-slot="progress-row"]')).toBeNull();
      }
      if (!columns.includes('cover')) expect(host.querySelector('[data-slot="cover"]')).toBeNull();
      if (!columns.includes('type')) expect(host.textContent).not.toContain('Book');
    }

    // Duplicate subjects retain independent assignments in exact incoming order, not subject-id order.
    selection = 'title';
    for (let index = 0; index < entries.length; index++) {
      mountKey++;
      await render();
      const form = await open(index);
      const entry = entries[index]!;
      expect(fields(form)).toEqual({
        intent: 'unassign', subjectId: entry.subjectId, labelId: entry.labelId, assignmentId: entry.id,
        idempotencyKey: entry.removeKey!, revision: String(entry.revision), csrf_token: 'original-csrf',
      });
      expect(new URL(form.action).searchParams.get('label')).toBe(label.id);
      expect(new URL(form.action).searchParams.get('columns')).toBe('title');
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(window.document.getElementById(submit.getAttribute('aria-describedby')!)?.textContent).toBe(label.name);
      // An open menu follows the assignment when the next render reorders duplicate subjects.
      const originalOperands = fields(form);
      await render([entries[2]!, entries[1]!, entries[0]!]);
      expect(fields(window.document.querySelector<HTMLFormElement>('form[method="post"]')!)).toEqual(originalOperands);
    }

    // Authority can retire after opening. The original form remains exact and its submit is rejected.
    const retained = window.document.querySelector<HTMLFormElement>('form[method="post"]')!;
    const original = fields(retained);
    current = false;
    const staleSubmit = new window.Event('submit', { bubbles: true, cancelable: true });
    await act(async () => { retained.dispatchEvent(staleSubmit); });
    expect(staleSubmit.defaultPrevented).toBe(true);
    expect(fields(retained)).toEqual(original);
    current = true;
    const currentSubmit = new window.Event('submit', { bubbles: true, cancelable: true });
    await act(async () => { retained.dispatchEvent(currentSubmit); });
    expect(currentSubmit.defaultPrevented).toBe(false);

    // Operation retirement removes controls and forms, without suppressing readable facts/tombstones.
    admitted = false;
    await render();
    expect(triggers()).toHaveLength(0);
    expect(window.document.querySelector('form')).toBeNull();
    expect(headers()).toEqual([m.library_column_title()]);
    expect(rows()).toHaveLength(3);
    expect(host.querySelector('[data-slot="tombstone"]')).not.toBeNull();
    selection = 'title,status';
    await render([{ ...entries[1]!, state: 'retired_state' }, entries[2]!]);
    expect(rows()[0]!.textContent).toContain(m.library_other());
    expect(rows()[1]!.textContent).not.toContain(m.library_other());
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    admission.mockRestore();
    mock.restore();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
