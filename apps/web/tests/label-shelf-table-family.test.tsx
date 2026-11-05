import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { LabelShelfEntry } from '../src/library/label-shelf-read';
import * as start from '../.storybook/react-start';

// Focused table-family outcomes; broader native and rendered acceptance remains with the controller.
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
      id: id(1202),
      labelId: label.id,
      subjectId: id(1101),
      revision: 9,
      removeKey: id(2202),
      subject,
      state: 'in_progress',
      stateLabel: 'Recorded state',
      activeProgressSession: {
        mode: 'scalar_amount',
        unit: 'percent',
        dimension: 'percent',
        amount: '0',
        total: null,
        completedUnitCount: 0,
        locator: null,
      },
    },
    {
      id: id(1201),
      labelId: label.id,
      subjectId: id(1101),
      revision: 3,
      removeKey: id(2201),
      subject,
      activeProgressSession: {
        mode: 'cursor_position',
        unit: 'page',
        amount: null,
        total: null,
        completedUnitCount: 0,
        locator: 'Recorded location',
        position: null,
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
      root.render(
        createElement(LabelShelfEntries, {
          key: mountKey,
          entries: rows,
          label,
          locale: 'en',
          layout: 'table',
          size: 'm',
          ...(selection ? { columns: selection } : {}),
          csrfToken: 'original-csrf',
          isCurrent: () => current,
        }),
      );
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
  const fields = (form: HTMLFormElement) =>
    Object.fromEntries(
      [...form.querySelectorAll<HTMLInputElement>('input[name]')].map((input) => [input.name, input.value]),
    );
  try {
    // Default supported facts: one table, no date/sort promises, zero distinct from unknown progress.
    await render();
    expect(host.querySelectorAll('table')).toHaveLength(1);
    expect(headers()).toEqual([
      m.library_column_cover(),
      m.library_column_title(),
      m.library_column_type(),
      m.library_label_table_status_progress(),
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
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      Array(2).fill(subjectHref({ id: subject.id, label: title }, 'en').href),
    );

    // Hidden facts stay hidden even though the independent action cell remains reachable.
    for (const [columns, expected] of [
      ['title', [m.library_column_title(), m.library_column_actions()]],
      ['title,type', [m.library_column_title(), m.library_column_type(), m.library_column_actions()]],
      ['title,added,finished,lastActivity', [m.library_column_title(), m.library_column_actions()]],
      [
        'cover,title,status',
        [m.library_column_cover(), m.library_column_title(), m.library_label_table_status_progress()],
      ],
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
        intent: 'unassign',
        subjectId: entry.subjectId,
        labelId: entry.labelId,
        assignmentId: entry.id,
        idempotencyKey: entry.removeKey!,
        revision: String(entry.revision),
        csrf_token: 'original-csrf',
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
    await act(async () => {
      retained.dispatchEvent(staleSubmit);
    });
    expect(staleSubmit.defaultPrevented).toBe(true);
    expect(fields(retained)).toEqual(original);
    current = true;
    const currentSubmit = new window.Event('submit', { bubbles: true, cancelable: true });
    await act(async () => {
      retained.dispatchEvent(currentSubmit);
    });
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

test('received-assignment reading keeps exact supplied values, bounded comparison, accessible controls and focus independently of mutations', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { contextExampleRelease, shelfContextExamples } = await import('../src/library/shelf-work-context/examples');
  const { prepareShelfWorkContext } = await import('../src/library/shelf-work-context/context');
  const { ReceivedAssignmentReader } = await import('../src/library/received-label-assignment-reading/view');
  const selection = await import('../src/library/received-label-assignment-reading/selection');
  const current = await import('../src/library/received-label-assignment-reading/current');
  const sample = shelfContextExamples('en')[0]!;
  const label = { id: 'label', name: 'Reading' };
  const rows: LabelShelfEntry[] = [
    {
      ...sample,
      id: 'assignment-b',
      labelId: label.id,
      revision: 9,
      entryIdentity: { subjectId: sample.subjectId, revision: 2 },
    },
    {
      ...sample,
      id: 'assignment-a',
      labelId: label.id,
      revision: 3,
      state: 'unknown-native-state',
      stateLabel: 'Supplied released state',
      activeProgressSession: {
        mode: 'scalar_amount',
        unit: 'page',
        unitLabel: 'pages',
        amount: '0.000000',
        total: '100.123456',
        completedUnitCount: 0,
        locator: null,
      },
    },
    {
      id: 'concealed',
      labelId: label.id,
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000009999',
      revision: 1,
      subject: null,
    },
  ].map((row) => ({ ...row, workContext: prepareShelfWorkContext(row, contextExampleRelease, 'en') }));
  const source = { observation: {}, entries: rows, label, locale: 'en', isCurrent: () => true };
  const visit = current.captureReceivedVisit(source);
  const first = selection.receivedObservation(rows, label.id, rows[0]!)!;
  const second = selection.receivedObservation(rows, label.id, rows[1]!)!;
  let reading = selection.chooseReceivedObservation(selection.emptyReceivedReading(), second);
  expect(reading.selected).toHaveLength(1);
  reading = selection.chooseReceivedObservation(reading, first);
  expect(reading.selected.map((item) => item.row.id)).toEqual(['assignment-b', 'assignment-a']);
  expect(current.receivedReadingIsCurrent(visit, source, reading)).toBe(true);
  const html = renderToStaticMarkup(
    createElement(ReceivedAssignmentReader, {
      id: 'reading',
      membershipId: 'membership',
      headingRef: { current: null },
      label,
      locale: 'en',
      reading,
      isCurrent: () => true,
      close() {},
      remove() {},
      replace() {},
      cancelReplacement() {},
    }),
  );
  expect(html.match(/data-received-assignment-observation/g)).toHaveLength(2);
  for (const text of ['Supplied released state', '0.000000', '100.123456', 'Author', 'Alex Lee', '2020'])
    expect(html).toContain(text);
  expect(html).toContain('lg:grid-cols-2');
  expect(html).toContain('/en/subjects/');
  expect(html).not.toMatch(/name="(?:csrf_token|idempotencyKey)"|<form|role="checkbox"/);
  for (const changed of [
    { ...source, observation: {} },
    { ...source, entries: rows.slice() },
    { ...source, label: { ...label, id: 'other-label' } },
    { ...source, locale: 'ja' },
    { ...source, isCurrent: () => false },
  ])
    expect(current.receivedReadingIsCurrent(visit, changed, reading)).toBe(false);
  for (const changed of [
    { revision: 10 },
    { subjectId: 'replacement-subject' },
    { subject: { ...rows[0]!.subject!, id: 'replacement-work' } },
    { entryIdentity: { subjectId: sample.subjectId, revision: 3 } },
    { stateLabel: 'Changed label' },
    { subject: null },
  ]) {
    const original = { ...rows[0]! };
    Object.assign(rows[0]!, changed);
    expect(current.receivedReadingIsCurrent(visit, source, reading)).toBe(false);
    Object.assign(rows[0]!, original);
  }
  const replacement = selection.receivedObservation(rows, label.id, rows[2]!)!;
  expect(selection.chooseReceivedObservation(reading, replacement)).toBe(reading);
  reading = selection.chooseReceivedObservation(selection.beginReceivedReplacement(reading, first), replacement);
  expect(reading.selected.map((item) => item.row.id)).toEqual(['assignment-a', 'concealed']);
  expect(selection.removeReceivedObservation(reading, reading.selected[0]!).selected).toHaveLength(1);
  visit.active = false;
  expect(current.receivedReadingIsCurrent(visit, source, reading)).toBe(false);
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
  let admitted = false;
  const admission = spyOn(exposure, 'useOperation').mockImplementation(
    (operation) => operation === 'library_label.unassign' && admitted,
  );
  const { LabelShelfEntries } = await import('../src/library/shelf-view');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const entries: LabelShelfEntry[] = [
    {
      ...rows[0]!,
      subject: { ...sample.subject!, label: { value: '日本語の長い題名', language: 'ja' } },
      stateLabel: 'Recorded state',
      activeProgressSession: {
        mode: 'scalar_amount',
        unit: 'percent',
        dimension: 'percent',
        amount: '0',
        total: null,
        completedUnitCount: 0,
        locator: null,
      },
    },
    {
      ...rows[1]!,
      subject: { ...sample.subject!, label: { value: '日本語の長い題名', language: 'ja' } },
      activeProgressSession: {
        mode: 'cursor_position',
        unit: 'page',
        amount: null,
        total: null,
        completedUnitCount: 0,
        locator: 'Recorded location',
        position: null,
      },
    },
    rows[2]!,
  ];
  delete entries[1]!.state;
  delete entries[1]!.stateLabel;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let readAdmitted = true;
  let pageObservation: object = {};
  let readingLocale = 'en';
  let layout: 'grid' | 'list' | 'table' = 'table';
  const render = async (received = entries) => {
    await act(async () =>
      root.render(
        createElement(LabelShelfEntries, {
          entries: received,
          label,
          locale: readingLocale,
          layout,
          size: 'm',
          csrfToken: null,
          isCurrent: () => false,
          readIsCurrent: () => readAdmitted,
          readObservation: pageObservation,
        }),
      ),
    );
  };
  try {
    // Accessible reading is independent of the writer; native actions and columns above retain their contract.
    label.name = '長いラベル名・'.repeat(30);
    await render();
    const reader = () => host.querySelector<HTMLElement>('[data-received-assignment-reader]');
    const readButtons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-received-assignment-trigger]')];
    const click = async (element: HTMLElement) => {
      await act(async () => element.click());
    };
    const read = async (index: number) => {
      await click(readButtons()[index]!);
    };
    const originalRows = structuredClone(entries);
    const requests = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Reading must not request'));
    try {
      const opening = readButtons()[1]!;
      await read(1);
      expect(reader()).not.toBeNull();
      expect(reader()!.getAttribute('aria-labelledby')).toBeTruthy();
      expect(window.document.activeElement?.tagName).toBe('H2');
      expect(reader()!.querySelectorAll('article')).toHaveLength(1);
      expect(reader()!.textContent).toContain('Recorded location');
      expect(reader()!.textContent).toContain(label.name);
      expect(reader()!.textContent).toContain(m.library_received_reading_state_unavailable());
      expect(reader()!.textContent).toContain(m.library_received_reading_entry_unavailable());
      expect(reader()!.textContent).toContain(m.library_received_reading_total_unknown());
      expect(reader()!.querySelector('[data-received-work-destination]')?.getAttribute('href')).toBe(
        subjectHref({ id: entries[0]!.subject!.id, label: '日本語の長い題名' }, 'en').href,
      );
      expect(reader()!.querySelector('form, input, [role="checkbox"]')).toBeNull();
      expect(reader()!.innerHTML).not.toContain('original-csrf');
      expect(reader()!.innerHTML).not.toContain(entries[1]!.removeKey!);
      await read(0);
      const articles = () => [...reader()!.querySelectorAll('article')];
      expect(articles()).toHaveLength(2);
      expect(articles()[0]!.textContent).toContain('Recorded state');
      expect(articles()[0]!.textContent).toContain('0%');
      expect(articles()[1]!.textContent).toContain('Recorded location');
      expect(reader()!.textContent).toContain(m.library_received_reading_count({ count: 2 }));
      await read(2); // No implicit replacement or third retained snapshot.
      expect(articles()).toHaveLength(2);
      expect(articles()[1]!.textContent).toContain('Recorded location');
      await click(articles()[1]!.querySelector<HTMLButtonElement>('[data-received-replace]')!);
      expect(reader()!.textContent).toContain(m.library_received_reading_replacing({ position: 2 }));
      await click(reader()!.querySelector<HTMLButtonElement>('[data-received-cancel-replacement]')!);
      await click(articles()[1]!.querySelector<HTMLButtonElement>('[data-received-replace]')!);
      await read(2);
      expect(articles()).toHaveLength(2);
      expect(articles()[1]!.textContent).toContain(m.library_subject_unavailable());
      expect(articles()[1]!.querySelector('a')).toBeNull();
      expect(articles()[1]!.textContent).not.toContain(entries[2]!.subjectId);
      await click(articles()[1]!.querySelector<HTMLButtonElement>('[data-received-remove]')!);
      expect(articles()).toHaveLength(1);
      expect(reader()!.textContent).toContain(m.library_received_reading_count({ count: 1 }));
      await click(reader()!.querySelector<HTMLButtonElement>('[data-received-close]')!);
      expect(reader()).toBeNull();
      expect(window.document.activeElement).toBe(opening);
      expect(entries).toEqual(originalRows);
      expect(requests).not.toHaveBeenCalled();

      // Display changes preserve the exact observation; a replaced opening control uses the stable shelf fallback.
      await read(0);
      for (const next of ['grid', 'list', 'table'] as const) {
        layout = next;
        window.innerWidth = next === 'list' ? 360 : 1280;
        await render();
        expect(reader()).not.toBeNull();
        expect(reader()!.querySelector('article')).not.toBeNull();
      }
      await act(async () =>
        reader()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(reader()).toBeNull();
      expect(window.document.activeElement).toBe(host.querySelector('[data-received-shelf]'));
      await read(0);
      pageObservation = {}; // Same IDs/array cannot keep an unrelated FULL response's reading.
      await render();
      expect(reader()).toBeNull();
      await read(0);
      await render(entries.map((entry) => ({ ...entry })));
      expect(reader()).toBeNull();
      await render();
      await read(0);
      readAdmitted = false;
      await render();
      expect(reader()).toBeNull();
      expect(readButtons()).toHaveLength(0);
      readAdmitted = true;
      await render();
      expect(reader()).toBeNull();
      await read(0);
      for (const locale of ['ja', 'zh-Hant']) {
        readingLocale = locale;
        await render();
        expect(reader()).toBeNull();
        await read(0);
        expect(reader()!.textContent).toContain(label.name);
        expect(reader()!.querySelector('h3')?.getAttribute('lang')).toBe('ja');
      }
    } finally {
      requests.mockRestore();
    }
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
