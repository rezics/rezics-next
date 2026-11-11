import { selectValue } from './support/select';
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import type { EntryAnnotationCorrectionPage } from '@rezics/client';
import { SelectedCorrection } from '../src/library/selected-entry-correction/controller';
import { correctionIssues, initialDraft, captureSelection } from '../src/library/selected-entry-correction/contract';
import type { CorrectionCommand, CorrectionPort } from '../src/library/selected-entry-correction/native';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const selected = {
  subjectId: 'native-subject',
  incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  currentRevision: 3,
};
const page = (): EntryAnnotationCorrectionPage => ({
  reviewId: 'review',
  epoch: 'epoch',
  state: 'open',
  createdAt: '2026-11-05',
  expiresAt: '2026-11-05T12:15:00Z',
  total: 1,
  page: 0,
  pageCount: 1,
  nextPage: null,
  items: [
    {
      selected,
      eligibility: 'ready',
      current: { annotationRevision: 1, note: 'native private note', priority: 7 },
      operation: { note: { op: 'preserve' }, priority: { op: 'clear' } },
      outcome: 'not-started',
    },
  ],
});
const personal = {
  subjectId: selected.subjectId,
  annotationRevision: 1,
  note: 'native private note',
  priority: 7,
  annotationUpdatedAt: null,
  sourceObservations: [],
};

test('explicit operations preserve defaults and reject empty set or oversized external note input', () => {
  expect(initialDraft()).toMatchObject({ note: 'preserve', priority: 'preserve' });
  expect(correctionIssues({ ...initialDraft(), note: 'set' }).note).toBe(true);
  expect(correctionIssues({ ...initialDraft(), note: 'set', noteValue: '語'.repeat(1366) }).note).toBe(true);
  expect(correctionIssues({ ...initialDraft(), note: 'clear', priority: 'set', priorityValue: '101' })).toEqual({
    note: false,
    priority: true,
  });
  expect(captureSelection([], ['title or position'])).toEqual([]);
});

test('cancellation reconciles an unknown original item; retirement drops callbacks and private facts', async () => {
  const commands: CorrectionCommand[] = [];
  let lost = true,
    active = true,
    refreshes = 0;
  const current = page();
  const port: CorrectionPort = {
    send: async (command) => {
      commands.push(command);
      if (command.kind === 'confirm' && lost) {
        lost = false;
        Object.assign(current, { items: [{ ...current.items[0]!, outcome: 'accepted' }] });
        return { kind: 'uncertain' };
      }
      if (command.kind === 'cancel')
        return {
          kind: 'ready',
          value: { reviewId: current.reviewId, epoch: current.epoch, state: 'cancelled', expiresAt: current.expiresAt },
        };
      return { kind: 'ready', value: { ...current } };
    },
    read: async () => ({ kind: 'ready', value: { ...current, state: 'cancelled' } }),
    personal: async () => ({ kind: 'ready', entry: personal }),
  };
  const visit = new SelectedCorrection(
    port,
    () => active,
    async () => {
      refreshes++;
    },
  );
  await visit.create([{ ...selected, note: { op: 'set', value: 'exact original' }, priority: { op: 'preserve' } }]);
  await visit.confirm(0);
  await visit.cancel();
  expect(commands.map((command) => command.kind)).toEqual(['create', 'confirm', 'confirm', 'cancel']);
  expect(commands[1]).toBe(commands[2]);
  expect(visit.snapshot().page!.state).toBe('cancelled');
  expect(refreshes).toBe(1);
  active = false;
  visit.retire();
  expect(visit.snapshot().page).toBeNull();
  expect(visit.snapshot().current).toEqual({});
  await visit.confirm(0);
  expect(commands).toHaveLength(4);
});

test('an unavailable native row retires earlier readback while another row is still being read', async () => {
  let next = page();
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let slow = false;
  const visit = new SelectedCorrection(
    {
      send: async () => ({ kind: 'ready', value: next }),
      read: async () => ({ kind: 'ready', value: next }),
      personal: async () => {
        if (slow) await blocked;
        return { kind: 'ready', entry: personal };
      },
    },
    () => true,
    async () => {},
  );
  await visit.create([{ ...selected, note: { op: 'preserve' }, priority: { op: 'preserve' } }]);
  expect(visit.snapshot().current[selected.subjectId]?.kind).toBe('ready');
  next = {
    ...next,
    items: [
      { ...next.items[0]!, eligibility: 'unavailable', current: null, operation: null },
      { ...next.items[0]!, selected: { ...selected, subjectId: 'second' } },
    ],
  };
  slow = true;
  const reading = visit.reopen();
  await Promise.resolve();
  expect(visit.snapshot().current[selected.subjectId]).toBeUndefined();
  release();
  await reading;
  expect(visit.snapshot().current[selected.subjectId]).toEqual({ kind: 'unavailable' });
});

test('accepted native cancellation survives failed reopening without synthesizing a review page', async () => {
  const nativePage = page();
  const commands: CorrectionCommand[] = [];
  const visit = new SelectedCorrection(
    {
      send: async (command) => {
        commands.push(command);
        return {
          kind: 'ready',
          value:
            command.kind === 'cancel'
              ? {
                  reviewId: nativePage.reviewId,
                  epoch: nativePage.epoch,
                  expiresAt: nativePage.expiresAt,
                  state: 'cancelled',
                }
              : nativePage,
        };
      },
      read: async () => ({ kind: 'uncertain' }),
      personal: async () => ({ kind: 'ready', entry: personal }),
    },
    () => true,
    async () => {},
  );
  await visit.create([{ ...selected, note: { op: 'preserve' }, priority: { op: 'preserve' } }]);
  await visit.cancel();
  expect(visit.snapshot().cancellation?.state).toBe('cancelled');
  expect(visit.snapshot().page).toBe(nativePage);
  await visit.confirm(0);
  expect(commands.map((command) => command.kind)).toEqual(['create', 'cancel']);
});

for (const width of [390, 1280])
  test(`production selected review, return and departure at ${width}px preserve the source address`, async () => {
    const { Window } = await import(
      Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
    );
    const window = new Window({
      url: 'https://site.test/en/library?state=planned&orderBy=priority&cursor=original',
      width,
    });
    const globals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      DocumentFragment: window.DocumentFragment,
      ShadowRoot: window.ShadowRoot,
      Document: window.Document,
      NodeFilter: window.NodeFilter,
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
    const previous = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { createRoot } = await import('react-dom/client');
    const { CorrectionVisit } = await import('../src/library/selected-entry-correction/view');
    const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
    const { m } = await import('../src/paraglide/messages.js');
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host);
    const source = window.location.href;
    let closed = false;
    const calls: CorrectionCommand[] = [];
    const current = page();
    const port: CorrectionPort = {
      send: async (command) => {
        calls.push(command);
        return { kind: 'ready', value: current };
      },
      read: async () => ({ kind: 'ready', value: current }),
      personal: async () => ({ kind: 'ready', entry: personal }),
    };
    const click = async (label: string) => {
      const target = [...window.document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
      if (!target) throw new Error('Missing control: ' + label);
      await act(async () => {
        target.click();
        await new Promise((done) => setTimeout(done, 20));
      });
    };
    try {
      await act(async () => {
        root.render(
          createElement(AuthoringDepartureProvider, {
            sessionBound: false,
            children: createElement(CorrectionVisit, {
              selection: [selected],
              isCurrent: () => true,
              lease: { current: false, listeners: new Set() },
              refreshEntries: async () => {},
              onClose: () => {
                closed = true;
              },
              makeController: (current) => new SelectedCorrection(port, current, async () => {}),
            }),
          }),
        );
      });
      expect([...host.querySelectorAll('[data-slot="select-trigger"]')].map(selectValue)).toEqual([
        'preserve',
        'preserve',
      ]);
      expect(host.querySelector('textarea')).toBeNull();
      await click(m.library_annotation_review());
      expect(host.textContent).toContain('native private note');
      expect(host.textContent).toContain(m.library_selected_correction_current());
      expect(calls[0]).toMatchObject({
        kind: 'create',
        items: [{ ...selected, note: { op: 'preserve' }, priority: { op: 'preserve' } }],
      });
      expect(window.document.activeElement?.textContent).toBe(m.library_annotation_review_title());
      await click(m.library_selected_correction_return());
      expect(closed).toBe(false);
      expect(window.document.body.textContent).toContain(m.thread_authoring_discard_title());
      await click(m.thread_authoring_stay());
      expect(closed).toBe(false);
      await click(m.library_selected_correction_return());
      await click(m.thread_authoring_discard());
      expect(closed).toBe(true);
      expect(window.location.href).toBe(source);
    } finally {
      await act(async () => root.unmount());
      window.happyDOM.abort();
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
  });
