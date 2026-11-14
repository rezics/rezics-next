import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, StrictMode } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import * as start from '../.storybook/react-start';
import type { HostedBookCheckpointProps } from '../src/books/reader/checkpoint';
import type { CheckpointView, CheckpointWrite } from '../src/books/reader/checkpoint-api';
import type { CheckpointDispatch, CheckpointTransport } from '../src/books/reader/checkpoint-intent';
import type { CheckpointObservation } from '../src/books/reader/native-checkpoint';
import type { BookChapterPage } from '../src/books/reader/source';

const window = new Window({ url: 'https://reader.test/en/' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const actualStart = await import('@tanstack/react-start');
const actualServer = await import('@tanstack/react-start/server');
mock.module('@tanstack/react-start', () => ({ ...actualStart, ...start }));
mock.module('@tanstack/react-start/server', () => ({ ...actualServer, ...start }));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { HostedBookCheckpoint } = await import('../src/books/reader/checkpoint');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const page: BookChapterPage = {
  kind: 'chapter',
  title: 'Original chapter',
  publicationTitle: 'Book',
  currentStructureRevisionId: id(2),
  ancestors: [],
  language: 'en',
  direction: 'ltr',
  address: {
    kind: 'chapter',
    publication: { id: id(1), structureRevisionId: id(2), releaseRevisionId: id(3) },
    selection: { occurrenceId: id(4), body: { postId: id(5), revisionId: id(6), sha256: 'a'.repeat(64) } },
  },
  body: { document: { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [] } } },
  contents: {
    kind: 'contents',
    publication: { id: id(1), structureRevisionId: id(2), releaseRevisionId: id(3) },
    parentOccurrenceId: null,
    cursor: null,
    selection: null,
  },
  previous: { state: 'end' },
  next: { state: 'end' },
};
const saved: Extract<CheckpointView, { state: 'saved' }> = {
  state: 'saved',
  subjectId: id(7),
  revision: '7',
  address: {
    catalogueId: id(1),
    publicationRevisionId: id(3),
    occurrenceId: id(4),
    targetRevisionId: id(6),
    targetSha256: 'a'.repeat(64),
    documentPosition: { blockId: 'before', offset: 73 },
  },
  resume: { availability: 'available', title: 'Previously saved chapter' },
};
const none: CheckpointView = { state: 'none', subjectId: id(7) };
const observation = (value: CheckpointView = saved): CheckpointObservation => ({
  state: 'ready',
  value,
  csrfToken: 'original-csrf',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function acknowledgement(request: CheckpointDispatch): CheckpointWrite {
  return {
    state: 'ready',
    value:
      request.data.command.kind === 'clear'
        ? none
        : {
            ...saved,
            revision: '8',
            address: request.data.command.address,
          },
  };
}
let root: Root | undefined;
let host: HTMLDivElement;
let props: HostedBookCheckpointProps;
async function render(patch: Partial<HostedBookCheckpointProps> = {}, strict = false) {
  props = { ...props, ...patch };
  await act(async () => {
    const component = <HostedBookCheckpoint {...props} />;
    root!.render(strict ? <StrictMode>{component}</StrictMode> : component);
  });
}
async function mount(transport: CheckpointTransport, strict = false) {
  setLocale('en', { reload: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  props = {
    subjectId: id(7),
    viewer: id(8),
    page,
    locale: 'en',
    isCurrent: () => true,
    reload: mock(() => {}),
    position: { capture: mock(() => ({ blockId: 'visible', offset: 0 })), restore: mock(() => {}) },
    transport,
  };
  await render({}, strict);
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((value) => value.textContent === label);
  expect(found).toBeDefined();
  return found!;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.focus();
    element.click();
  });
}
async function clearCheckpoint() {
  const disclosure = host.querySelector('details')!;
  disclosure.open = true;
  await click(button(m.book_reader_checkpoint_clear()));
}
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
afterAll(async () => {
  mock.module('@tanstack/react-start', () => actualStart);
  mock.module('@tanstack/react-start/server', () => actualServer);
  mock.restore();
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('lost save replays its original sender, envelope, exact body, CAS and position without a new read or capture', async () => {
  const read = mock(async (_request: Parameters<CheckpointTransport['read']>[0]) => observation());
  let calls = 0;
  const write = mock(async (request: CheckpointDispatch): Promise<CheckpointWrite> => {
    if (calls++ === 0) throw new TypeError('lost response');
    return acknowledgement(request);
  });
  const transport: CheckpointTransport = { read, write };
  await mount(transport);
  expect(props.position.restore).toHaveBeenCalledWith(saved, expect.any(window.HTMLElement));
  await click(button(m.book_reader_checkpoint_save()));
  expect(host.textContent).toContain(m.book_reader_checkpoint_uncertain());
  expect(host.textContent).toContain(m.book_reader_checkpoint_intent_save({ chapter: page.title }));
  expect(host.textContent).toContain(
    m.book_reader_checkpoint_observed_saved({
      chapter: saved.resume.availability === 'available' ? saved.resume.title : '',
    }),
  );
  expect(button(m.book_reader_checkpoint_save()).disabled).toBe(true);
  expect(button(m.book_reader_checkpoint_clear()).disabled).toBe(true);
  expect(props.position.restore).toHaveBeenCalledWith(saved, host.querySelector('section'));
  const first = write.mock.calls[0]![0];
  expect(first.data).toEqual({
    viewer: id(8),
    locale: 'en',
    key: expect.any(String),
    command: {
      kind: 'save',
      subjectId: id(7),
      expectedRevision: '7',
      address: { ...saved.address, documentPosition: { blockId: 'visible', offset: 0 } },
    },
  });
  expect(first.headers).toEqual({ 'X-CSRF-Token': 'original-csrf' });
  expect(first.signal).toBe(read.mock.calls[0]![0].signal);
  props.position.capture = mock(() => ({ blockId: 'scrolled-after-save', offset: 0 }));
  const replacementSender = mock(async () => ({ state: 'uncertain' as const }));
  transport.write = replacementSender;
  await click(button(m.book_reader_checkpoint_retry_save()));
  expect(write.mock.calls[1]![0]).toBe(first);
  expect(replacementSender).not.toHaveBeenCalled();
  expect(props.position.capture).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(m.book_reader_checkpoint_saved());
  const link = host.querySelector('a')!;
  const href = new URL(link.href);
  expect(href.pathname).toBe(`/en/books/${id(1)}/read`);
  expect([...href.searchParams.keys()].sort()).toEqual(['occurrence', 'release', 'subject', 'view']);
  expect(href.hash).toBe('');
});

test('unknown clear retains its supplied saved chapter, replays CAS and confirms only native none', async () => {
  let attempts = 0;
  const write = mock(async (request: CheckpointDispatch): Promise<CheckpointWrite> =>
    attempts++ === 0 ? { state: 'uncertain' } : acknowledgement(request),
  );
  await mount({ read: async () => observation(), write });
  await clearCheckpoint();
  expect(host.textContent).toContain(m.book_reader_checkpoint_intent_clear({ chapter: 'Previously saved chapter' }));
  expect(host.textContent).toContain(m.book_reader_checkpoint_clear_scope());
  expect(button(m.book_reader_checkpoint_save()).disabled).toBe(true);
  expect(write.mock.calls[0]![0].data.command).toEqual({ kind: 'clear', subjectId: id(7), expectedRevision: '7' });
  await click(button(m.book_reader_checkpoint_retry_clear()));
  expect(write.mock.calls[1]![0]).toBe(write.mock.calls[0]![0]);
  expect(host.textContent).toContain(m.book_reader_checkpoint_cleared());
  expect(host.textContent).toContain(m.book_reader_checkpoint_observed_none());
  expect(host.querySelector('a')).toBeNull();
  expect(button(m.book_reader_checkpoint_save()).disabled).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('[role="status"]'));
});

for (const variation of ['conflict', 'different-digest', 'different-position', 'clear-still-saved'] as const) {
  test(`${variation} requires explicit current-reading recovery and never claims the original action succeeded`, async () => {
    await mount({
      read: async () => observation(),
      write: async (request) =>
        variation === 'conflict'
          ? { state: 'conflict' }
          : {
              state: 'ready',
              value: {
                ...saved,
                resume: { availability: 'available', title: 'Independent current chapter' },
                address:
                  request.data.command.kind === 'save'
                    ? {
                        ...request.data.command.address,
                        ...(variation === 'different-digest'
                          ? { targetSha256: 'b'.repeat(64) }
                          : { documentPosition: null }),
                      }
                    : saved.address,
              },
            },
    });
    if (variation === 'clear-still-saved') await clearCheckpoint();
    else await click(button(m.book_reader_checkpoint_save()));
    expect(host.textContent).toContain(m.book_reader_changed());
    expect(host.textContent).not.toContain(m.book_reader_checkpoint_saved());
    expect(host.textContent).not.toContain(m.book_reader_checkpoint_cleared());
    expect(button(m.book_reader_checkpoint_save()).disabled).toBe(true);
    if (variation !== 'conflict')
      expect(host.textContent).toContain(
        m.book_reader_checkpoint_observed_saved({ chapter: 'Independent current chapter' }),
      );
    await click(button(m.book_reader_checkpoint_recover_current()));
    expect(props.reload).toHaveBeenCalledTimes(1);
  });
}

test('failed checkpoint read retries only its original reading operands, preserves a Library edit and focuses its result', async () => {
  let reads = 0;
  const read = mock(async (_request: Parameters<CheckpointTransport['read']>[0]) =>
    reads++ === 0 ? { state: 'unavailable' as const } : observation(none),
  );
  const write = mock(async () => ({ state: 'uncertain' as const }));
  await mount({ read, write });
  const edit = document.createElement('input');
  edit.value = 'independent Library progress draft';
  host.prepend(edit);
  expect(host.textContent).not.toContain(m.book_reader_checkpoint_none());
  expect(host.textContent).toContain(m.book_reader_checkpoint_unavailable());
  expect(host.querySelector('a')).toBeNull();
  await click(button(m.book_reader_checkpoint_retry_read()));
  expect(read.mock.calls[1]![0]).toEqual(read.mock.calls[0]![0]);
  expect(props.position.restore).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  expect(edit.value).toBe('independent Library progress draft');
  expect(document.activeElement).toBe(host.querySelector('[role="status"]'));
  expect(host.textContent).toContain(m.book_reader_checkpoint_none());
});

for (const replacement of ['viewer', 'locale', 'page', 'subject', 'credential', 'position'] as const) {
  test(`${replacement} replacement discards the uncertain visit and fences its late acknowledgement`, async () => {
    const late = deferred<CheckpointWrite>();
    let sent!: CheckpointDispatch;
    const read = mock(async () => observation(none));
    await mount({
      read,
      write: async (request) => {
        sent = request;
        return late.promise;
      },
    });
    await click(button(m.book_reader_checkpoint_save()));
    const patch: Partial<HostedBookCheckpointProps> =
      replacement === 'viewer'
        ? { viewer: id(9) }
        : replacement === 'locale'
          ? { locale: 'fr' }
          : replacement === 'subject'
            ? { subjectId: id(10) }
            : replacement === 'credential'
              ? { isCurrent: () => true }
              : replacement === 'position'
                ? { position: { capture: () => null, restore: mock(() => {}) } }
                : { page: { ...page } };
    await render(patch);
    expect(sent.signal.aborted).toBe(true);
    await act(async () => late.resolve(acknowledgement(sent)));
    expect(host.textContent).not.toContain(m.book_reader_checkpoint_saved());
    expect(host.textContent).not.toContain(m.book_reader_checkpoint_intent_save({ chapter: page.title }));
    expect(host.querySelector('a')).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
}

test('equal-value A/B/A visits fence late reads and never restore a retired private checkpoint', async () => {
  const late = deferred<CheckpointObservation>();
  let calls = 0;
  const read = mock(async () => (calls++ === 0 ? late.promise : observation(none)));
  await mount({ read, write: async () => ({ state: 'uncertain' }) });
  const original = props.page;
  await render({ page: { ...page } });
  await render({ page: original });
  await act(async () => late.resolve(observation()));
  expect(host.textContent).toContain(m.book_reader_checkpoint_none());
  expect(host.textContent).not.toContain('Previously saved chapter');
  expect(props.position.restore).toHaveBeenCalledTimes(2);
});

test('a fresh matching observation after replacement never confirms the uncertain original save', async () => {
  let sent!: CheckpointDispatch;
  let reads = 0;
  await mount({
    read: async () =>
      observation(
        reads++ === 0
          ? none
          : {
              ...saved,
              address: sent.data.command.kind === 'save' ? sent.data.command.address : saved.address,
            },
      ),
    write: async (request) => {
      sent = request;
      return { state: 'uncertain' };
    },
  });
  await click(button(m.book_reader_checkpoint_save()));
  expect(button(m.book_reader_checkpoint_save()).disabled).toBe(true);
  await render({ page: { ...page } });
  expect(host.textContent).toContain('Previously saved chapter');
  expect(host.textContent).not.toContain(m.book_reader_checkpoint_saved());
  expect(
    [...host.querySelectorAll('button')].some((entry) => entry.textContent === m.book_reader_checkpoint_retry_save()),
  ).toBe(false);
});

test('moving focus during an active request cancels result focus even when focus returns to the reading controls', async () => {
  const late = deferred<CheckpointWrite>();
  let sent!: CheckpointDispatch;
  await mount({
    read: async () => observation(),
    write: async (request) => {
      sent = request;
      return late.promise;
    },
  });
  await click(button(m.book_reader_checkpoint_save()));
  const elsewhere = document.createElement('button');
  document.body.append(elsewhere);
  elsewhere.focus();
  const summary = host.querySelector('summary')!;
  summary.focus();
  await act(async () => late.resolve(acknowledgement(sent)));
  expect(document.activeElement).toBe(summary);
});

test('retirement removes private controls and prevents late effects and keyboard focus theft', async () => {
  const late = deferred<CheckpointWrite>();
  let current = true;
  await mount({ read: async () => observation(), write: async () => late.promise });
  await render({ isCurrent: () => current });
  await clearCheckpoint();
  const elsewhere = document.createElement('button');
  document.body.append(elsewhere);
  elsewhere.focus();
  current = false;
  await render();
  expect(host.textContent).toBe('');
  await act(async () => late.resolve({ state: 'ready', value: none }));
  expect(document.activeElement).toBe(elsewhere);
  expect(props.reload).not.toHaveBeenCalled();
});

test('withheld saved destination retains Clear without a resume link, and denial removes supplied private context', async () => {
  const write = mock(async (_request: CheckpointDispatch): Promise<CheckpointWrite> => ({ state: 'denied' }));
  await mount({ read: async () => observation({ ...saved, resume: { availability: 'unavailable' } }), write });
  expect(host.textContent).toContain(m.book_reader_checkpoint_withheld());
  expect(host.querySelector('a')).toBeNull();
  await clearCheckpoint();
  expect(write.mock.calls[0]![0].data.command).toEqual({ kind: 'clear', subjectId: id(7), expectedRevision: '7' });
  expect(host.textContent).not.toContain(m.book_reader_checkpoint_none());
  expect(host.querySelector('details')).toBeNull();
});

test('Strict Mode replacement setup owns a fresh signal and rejects the retired setup response', async () => {
  const late = deferred<CheckpointObservation>();
  const requests: Parameters<CheckpointTransport['read']>[0][] = [];
  await mount(
    {
      read: async (request) => {
        requests.push(request);
        return requests.length === 1 ? late.promise : observation(none);
      },
      write: async () => ({ state: 'uncertain' }),
    },
    true,
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(false);
  await act(async () => late.resolve(observation()));
  expect(host.textContent).not.toContain('Previously saved chapter');
  expect(host.querySelector('a')).toBeNull();
});
