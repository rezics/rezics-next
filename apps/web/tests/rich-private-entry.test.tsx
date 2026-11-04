import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import { createKernelClient, type PersonalEntry } from '@rezics/client';
import { annotationWrite, annotationIssues, renewAnnotationDraft } from '../src/library/rich-private-entry/contract';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const guard = { incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000001', currentRevision: 3 };
const entry: PersonalEntry = {
  subjectId: 'subject-1',
  annotationRevision: 4,
  note: 'private note',
  priority: 7,
  annotationUpdatedAt: '2026-01-01T00:00:00Z',
  sourceObservations: [
    {
      provider: 'source',
      recordId: 'keep',
      revision: 2,
      privacy: { status: 'unknown', sourceValue: 'only-me' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
      recordedAt: '2026-01-01',
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pause = () => new Promise((done) => setTimeout(done, 12));

async function reader() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/subject-1/book' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const exposure = await import('../src/kernel/exposure');
  const allow = spyOn(exposure, 'useOperation').mockReturnValue(true);
  const { RichPrivateEntry } = await import('../src/library/rich-private-entry/view');
  const { m } = await import('../src/paraglide/messages.js');
  type Props = ComponentProps<typeof RichPrivateEntry>;
  type Transport = NonNullable<Props['transport']>;
  type Outcome = Awaited<ReturnType<Transport['annotations']>>;
  const writes: {
    command: Parameters<Transport['annotations']>[0]['data'];
    reply: ReturnType<typeof deferred<Outcome>>;
  }[] = [];
  const sources: Parameters<Transport['sourceCorrection']>[0]['data'][] = [];
  let latest = entry;
  let reads = 0;
  let active = true;
  let credential = 'captured-credential';
  const transport: Transport = {
    read: async () => {
      reads++;
      return { kind: 'ready', viewer: 'A', csrfToken: 'captured-csrf', credential, entry: latest };
    },
    annotations: async ({ data }) => {
      const reply = deferred<Outcome>();
      writes.push({ command: data, reply });
      return reply.promise;
    },
    sourceCorrection: async ({ data }) => {
      sources.push(data);
      return { kind: 'uncertain' };
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let props: Props = {
    subject: { id: entry.subjectId, label: 'Book' },
    session: { state: 'signed-in', subject: 'A', csrfToken: 'session-csrf' },
    admitted: true,
    returnTo: '/en/subjects/subject-1/book',
    entryGuard: guard,
    origin: { lifetime: 'original', isCurrent: () => active, refreshEntry: async () => true },
    transport,
  };
  const render = async (changes: Partial<Props> = {}) => {
    props = { ...props, ...changes };
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client, children: createElement(RichPrivateEntry, props) })),
    );
    await act(async () => pause());
  };
  const button = (label: string) => {
    const node = [...window.document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!node) throw new Error('Button not found: ' + label);
    return node;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await pause();
    });
  const note = () => host.querySelector('textarea')!;
  const rank = () => host.querySelector('input[inputmode=numeric]')!;
  const change = async (element: Element, value: string) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    const properties = (element as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!;
    await act(async () => {
      if (properties) properties.onChange({ currentTarget: { value } });
      else {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);
        element.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    });
  };
  const reply = async (index: number, outcome: Outcome) =>
    act(async () => {
      writes[index]!.reply.resolve(outcome);
      await pause();
    });
  const refresh = async () =>
    act(async () => {
      await client.refetchQueries({ queryKey: ['library', 'rich-private-entry'] });
      await pause();
    });
  const diary = () => host.querySelector('a')!;
  const openDiary = async () =>
    act(async () => {
      diary().click();
      await pause();
    });
  const cleanup = async () => {
    await act(async () => root.unmount());
    client.clear();
    allow.mockRestore();
    window.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  };
  return {
    host,
    window,
    render,
    button,
    click,
    note,
    rank,
    change,
    reply,
    refresh,
    diary,
    openDiary,
    cleanup,
    m,
    writes,
    sources,
    client,
    setLatest: (value: PersonalEntry) => {
      latest = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setCredential: (value: string) => {
      credential = value;
    },
    reads: () => reads,
  };
}

test('edit and review: exact values, native bounds, clear versus unchanged, correction, cancellation and deliberate discard', async () => {
  const r = await reader();
  const { m } = r;
  try {
    await r.render();
    await r.click(m.library_annotation_review());
    expect(r.host.textContent).toContain(m.library_annotation_no_change());
    const reads = r.reads();
    const text = '  first line\n\n second line  \n';
    await r.change(r.note(), text);
    await r.click(m.library_annotation_review());
    const review = r.host.querySelector('section section')!;
    expect(review.textContent).toContain('Book');
    expect(review.textContent).toContain(entry.note);
    expect([...review.querySelectorAll('.whitespace-pre-wrap')].map((node) => node.textContent)).toEqual([
      entry.note,
      text,
    ]);
    expect(review.textContent).toContain(m.library_annotation_unchanged());
    expect(r.writes).toHaveLength(0);
    await r.click(m.library_annotation_edit_note());
    expect(r.window.document.activeElement).toBe(r.note());
    expect(r.note().value).toBe(text);
    expect(r.host.textContent).not.toContain(m.library_annotation_review_title());
    await r.change(r.note(), 'é'.repeat(2049));
    await r.change(r.rank(), '1.5');
    await r.click(m.library_annotation_review());
    expect(r.window.document.activeElement).toBe(r.note());
    expect(r.note().getAttribute('aria-invalid')).toBe('true');
    expect(r.host.textContent).toContain(m.library_annotation_note_error());
    expect(r.host.textContent).toContain(m.library_annotation_priority_error());
    await r.change(r.note(), 'é'.repeat(2048));
    await r.click(m.library_annotation_review());
    expect(r.window.document.activeElement).toBe(r.rank());
    for (const value of ['0', '101', '-1', '1e1', 'abc']) {
      expect(annotationIssues({ note: '', priority: value }).priority).toBe('rank');
    }
    await r.change(r.rank(), '100');
    await r.click(m.library_annotation_review());
    await r.click(m.library_annotation_back());
    expect(r.window.document.activeElement).toBe(r.button(m.library_annotation_review()));
    expect(r.note().value).toBe('é'.repeat(2048));
    await r.click(m.library_annotation_discard());
    await r.click(m.library_annotation_stay());
    expect(r.note().value).toBe('é'.repeat(2048));
    await r.click(m.library_annotation_discard());
    await r.click(m.library_annotation_confirm_discard());
    expect(r.note().value).toBe(entry.note!);
    expect(r.rank().value).toBe('7');
    expect(r.window.document.activeElement).toBe(r.button(m.library_annotation_discard()));
    expect(r.host.textContent).toContain(m.library_annotation_discarded());
    await r.click(m.library_rich_entry_clear_note());
    await r.click(m.library_annotation_review());
    expect(r.host.textContent).toContain(m.library_annotation_note_cleared());
    expect(r.host.textContent).toContain(m.library_annotation_priority_preserved());
    await r.click(m.library_annotation_edit_priority());
    await r.click(m.library_rich_entry_clear_priority());
    expect(annotationWrite(entry, { note: '', priority: '' }, guard)).toMatchObject({
      note: { op: 'clear' },
      priority: { op: 'clear' },
    });
    expect(annotationWrite(entry, { note: entry.note!, priority: '' }, guard)?.note).toEqual({ op: 'unchanged' });
    expect(annotationWrite({ ...entry, note: null, priority: null }, { note: '', priority: '' }, guard)).toBeNull();
    expect(annotationWrite(entry, { note: text, priority: '7' }, guard)?.note).toEqual({ op: 'set', value: text });
    expect(annotationWrite(entry, { note: 'é'.repeat(2049), priority: '7' }, guard)).toBeNull();
    expect(
      renewAnnotationDraft(
        entry,
        { ...entry, note: 'fresh', priority: 3 },
        { note: entry.note!, priority: '101' },
        guard,
      ),
    ).toEqual({ note: 'fresh', priority: '101' });
    expect(
      renewAnnotationDraft(
        entry,
        { ...entry, note: 'fresh', priority: 3 },
        { note: 'é'.repeat(2049), priority: '7' },
        guard,
      ),
    ).toEqual({ note: 'é'.repeat(2049), priority: '3' });
    expect(r.writes).toHaveLength(0);
    expect(r.sources).toHaveLength(0);
    expect(r.reads()).toBe(reads);
  } finally {
    await r.cleanup();
  }
});

test('commands: final Save uses captured operands and identity, duplicate guard, original retry and renewed conflict review', async () => {
  const r = await reader();
  const { m } = r;
  try {
    await r.render();
    await r.change(r.rank(), '1');
    await r.click(m.library_annotation_review());
    expect(r.writes).toHaveLength(0);
    r.setCredential('background-credential');
    await r.refresh();
    await act(async () => {
      r.button(m.library_rich_entry_save()).click();
      r.button(m.library_rich_entry_save()).click();
    });
    expect(r.writes).toHaveLength(1);
    const original = r.writes[0]!.command;
    expect(original).toMatchObject({
      viewer: 'A',
      credential: 'captured-credential',
      csrfToken: 'captured-csrf',
      body: {
        revision: 4,
        entryGuard: guard,
        note: { op: 'unchanged' },
        priority: { op: 'set', value: 1 },
      },
    });
    expect(Object.keys(original.body).sort()).toEqual(['entryGuard', 'note', 'priority', 'revision']);
    await r.reply(0, { kind: 'uncertain' });
    r.setLatest({ ...entry, note: 'new received note', annotationRevision: 5 });
    await r.refresh();
    expect(r.host.textContent).toContain(m.library_rich_entry_uncertain());
    expect(
      [...r.host.querySelectorAll('button')].some((node) => node.textContent === m.library_rich_entry_review_latest()),
    ).toBe(false);
    expect(r.host.textContent).not.toContain(m.library_annotation_saved());
    await r.openDiary();
    expect(r.window.document.body.textContent).toContain(m.library_annotation_unresolved_departure());
    expect(
      [...r.window.document.querySelectorAll('a')].some((a) => a.textContent === m.library_annotation_discard_leave()),
    ).toBe(false);
    await r.click(m.library_annotation_stay());
    await r.click(m.library_rich_entry_retry());
    expect(r.writes[1]!.command).toEqual(original);
    await r.reply(1, { kind: 'conflict' });
    expect(r.host.textContent).toContain('new received note');
    expect(r.button(m.library_annotation_review()).disabled).toBe(true);
    await r.click(m.library_rich_entry_review_latest());
    expect(r.writes).toHaveLength(2);
    await r.click(m.library_annotation_review());
    await r.click(m.library_rich_entry_save());
    expect(r.writes[2]!.command.key).not.toBe(original.key);
    expect(r.writes[2]!.command.body).toMatchObject({
      revision: 5,
      note: { op: 'unchanged' },
      priority: { op: 'set', value: 1 },
    });
    await r.reply(2, {
      kind: 'saved',
      entry: { ...entry, note: 'native confirmed', priority: 1, annotationRevision: 6 },
    });
    expect(r.host.textContent).toContain(m.library_annotation_saved());
    expect(r.host.textContent).toContain('native confirmed');
    expect(r.note().value).toBe('native confirmed');
  } finally {
    await r.cleanup();
  }
  const { annotationInput } = await import('../src/library/rich-private-entry/server');
  const body = annotationWrite(entry, { note: entry.note!, priority: '1' }, guard)!;
  expect(annotationInput(body)).toEqual(body);
  expect(annotationInput({ ...body, entryGuard: undefined })).toBeNull();
  expect(annotationInput({ ...body, entryGuard: { ...guard, currentRevision: 0 } })).toBeNull();
  expect(annotationWrite(entry, { note: entry.note!, priority: '1' }, null)).toBeNull();
  const { writePrivateAnnotations } = await import('../src/library/rich-private-entry/native');
  for (const status of [409, 422]) {
    let sent: Request | undefined;
    const client = createKernelClient('https://api.test', {
      fetch: async (input, init) => {
        sent = new Request(input, init);
        return Response.json({ code: status === 409 ? 'conflict' : 'idempotency_conflict' }, { status });
      },
    });
    expect(
      await writePrivateAnnotations(client, {
        subjectId: entry.subjectId,
        body,
        key: guard.incarnationId,
        authorization: 'Bearer captured',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await sent!.json()).toEqual(body);
    expect(sent!.headers.get('authorization')).toBe('Bearer captured');
    expect(sent!.headers.get('idempotency-key')).toBe(guard.incarnationId);
  }
  const { captureAnnotationCredential, originalAnnotationCredential } =
    await import('../src/library/rich-private-entry/credential');
  const env = { WEBSITE_CLIENT_KEY: 'private-test-key' };
  const request = (session = 'original', origin = 'https://site.test') =>
    new Request(origin + '/entry', { headers: { cookie: '__Host-rezics_session=' + session } });
  const identity = { viewer: 'A', csrfToken: 'old-csrf', authorization: 'Bearer original-account-lifetime' };
  const credential = await captureAnnotationCredential(request(), env, identity, entry.subjectId);
  const command = { ...identity, subjectId: entry.subjectId, credential };
  const rotated = { ...identity, csrfToken: 'new-csrf', authorization: 'Bearer rotated' };
  expect(await originalAnnotationCredential(request(), env, rotated, command)).toBe(identity.authorization);
  for (const [req, actor, input] of [
    [request('new-session'), rotated, command],
    [request('original', 'https://other.test'), rotated, command],
    [request(), { ...rotated, viewer: 'B' }, command],
    [request(), rotated, { ...command, subjectId: 'different' }],
  ] as const)
    expect(await originalAnnotationCredential(req, env, actor, input)).toBeNull();
});

test('origin: diary decision and focus, independent source editing and retirement reject private draft restoration and late callbacks', async () => {
  const r = await reader();
  const { m } = r;
  try {
    await r.render();
    await r.change(r.note(), 'unsent draft');
    const href = r.diary().getAttribute('href');
    expect(href).toBe('/library/history?returnTo=' + encodeURIComponent('/en/subjects/subject-1/book'));
    await r.openDiary();
    await r.click(m.library_annotation_stay());
    expect(r.window.document.activeElement).toBe(r.diary());
    expect(r.note().value).toBe('unsent draft');
    await r.click(m.library_rich_entry_edit_source_facts());
    const select = r.host.querySelector('select')!;
    await r.change(select, 'clear');
    await r.click(m.library_annotation_review());
    await r.click(m.library_annotation_discard());
    await r.click(m.library_annotation_confirm_discard());
    expect(select.value).toBe('clear');
    expect(r.sources).toHaveLength(0);
    await r.change(r.note(), 'another draft');
    await r.openDiary();
    expect(r.window.document.body.textContent).toContain(m.library_annotation_source_departure());
    await r.click(m.library_annotation_stay());
    await r.click(m.library_rich_entry_cancel());
    await r.openDiary();
    const leave = [...r.window.document.querySelectorAll('a')].find(
      (node) => node.textContent === m.library_annotation_discard_leave(),
    )!;
    expect(leave.getAttribute('href')).toBe(href);
    await act(async () => {
      leave.click();
      await pause();
    });
    expect(r.writes).toHaveLength(0);
    await r.render({ origin: { lifetime: 'visit-2', isCurrent: () => true, refreshEntry: async () => true } });
    expect(r.note().value).toBe(entry.note!);
    await r.change(r.rank(), '2');
    await r.click(m.library_annotation_review());
    await r.click(m.library_rich_entry_save());
    await r.render({ entryGuard: null });
    await r.reply(0, { kind: 'saved', entry: { ...entry, note: 'LATE REMOVED ENTRY' } });
    expect(r.host.textContent).not.toContain('LATE REMOVED ENTRY');
    await r.render({ entryGuard: { ...guard, incarnationId: 'restored-entry' } });
    expect(r.note().value).toBe(entry.note!);
    expect(r.rank().value).toBe('7');
    for (const changes of [
      { admitted: false },
      { session: { state: 'signed-out' as const } },
      { subject: { id: 'other', label: 'Other' } },
    ]) {
      await r.change(r.note(), 'PRIVATE RETIRED DRAFT');
      await r.render(changes);
      expect(r.host.textContent).not.toContain('PRIVATE RETIRED DRAFT');
      await r.render({
        admitted: true,
        subject: { id: entry.subjectId, label: 'Book' },
        session: { state: 'signed-in', subject: 'A', csrfToken: 'session-csrf' },
      });
      expect(r.note().value).toBe(entry.note!);
    }
    await r.change(r.note(), 'ABA draft');
    r.setActive(false);
    await r.render({ origin: { lifetime: 'original-aba', isCurrent: () => false, refreshEntry: async () => true } });
    r.setActive(true);
    await r.render({ origin: { lifetime: 'visit-3', isCurrent: () => true, refreshEntry: async () => true } });
    expect(r.note().value).toBe(entry.note!);
    await r.change(r.rank(), '2');
    await r.click(m.library_annotation_review());
    await r.click(m.library_rich_entry_save());
    await act(async () => r.client.removeQueries({ queryKey: ['library', 'rich-private-entry'] }));
    await r.reply(1, { kind: 'saved', entry: { ...entry, note: 'REMOVED QUERY VALUE' } });
    expect(r.host.textContent).not.toContain('REMOVED QUERY VALUE');
    expect(r.host.querySelector('textarea')).toBeNull();
  } finally {
    await r.cleanup();
  }
});
