import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import { createKernelClient, type PersonalEntry } from '@rezics/client';
import { annotationWrite } from '../src/library/rich-private-entry/contract';

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
  sourceObservations: [],
};

test('private annotation edits clear only the field the owner changed', () => {
  expect(annotationWrite(entry, { note: 'revised note', priority: '7' }, guard)).toEqual({
    entryGuard: guard,
    revision: 4,
    note: { op: 'set', value: 'revised note' },
    priority: { op: 'unchanged' },
  });
  expect(annotationWrite(entry, { note: 'private note', priority: '' }, guard)).toEqual({
    entryGuard: guard,
    revision: 4,
    note: { op: 'unchanged' },
    priority: { op: 'clear' },
  });
});

test('private annotation bounds use UTF-8 bytes and unchanged edits send no command', () => {
  expect(annotationWrite({ ...entry, note: null, priority: null }, { note: '', priority: '' }, guard)).toBeNull();
  expect(annotationWrite({ ...entry, note: null }, { note: 'é'.repeat(2048), priority: '7' }, guard)?.note).toEqual({
    op: 'set',
    value: 'é'.repeat(2048),
  });
  expect(annotationWrite(entry, { note: 'é'.repeat(2049), priority: '7' }, guard)).toBeNull();
  expect(annotationWrite(entry, { note: entry.note!, priority: '101' }, guard)).toBeNull();
});

test('annotation validation requires and retains the reviewed Entry incarnation', async () => {
  const { annotationInput } = await import('../src/library/rich-private-entry/server');
  const write = annotationWrite(entry, { note: entry.note!, priority: '1' }, guard)!;
  expect(annotationInput(write)).toEqual(write);
  expect(annotationInput({ ...write, entryGuard: undefined })).toBeNull();
  expect(annotationInput({ ...write, entryGuard: { ...guard, currentRevision: 0 } })).toBeNull();
  expect(annotationWrite(entry, { note: entry.note!, priority: '1' }, null)).toBeNull();
});

test('annotation credentials keep the captured bearer and refuse a different account lifetime, origin or Subject', async () => {
  const { captureAnnotationCredential, originalAnnotationCredential } =
    await import('../src/library/rich-private-entry/credential');
  const env = { WEBSITE_CLIENT_KEY: 'private-test-key' };
  const request = (session = 'original', origin = 'https://site.test') =>
    new Request(origin + '/entry', {
      headers: { cookie: '__Host-rezics_session=' + session },
    });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('rendered review preserves operands and focus, retries original uncertainty, reviews stale incarnations and retires late replies', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/subject-1/book' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
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
  type Outcome = Awaited<ReturnType<NonNullable<Props['transport']>['annotations']>>;
  const writes: {
    command: Parameters<NonNullable<Props['transport']>['annotations']>[0];
    reply: ReturnType<typeof deferred<Outcome>>;
  }[] = [];
  let latest = {
    ...entry,
    sourceObservations: [
      {
        provider: 'source',
        recordId: 'keep',
        revision: 2,
        privacy: { status: 'unknown' as const, sourceValue: 'only-me' },
        sourceCreated: { status: 'absent' as const },
        sourceUpdated: { status: 'absent' as const },
        recordedAt: '2026-01-01',
      },
    ],
  };
  let active = true;
  let lifetime = 'original';
  let currentGuard = guard;
  const transport: NonNullable<Props['transport']> = {
    read: async () => ({
      kind: 'ready',
      viewer: 'A',
      csrfToken: 'captured-csrf',
      credential: 'captured-credential',
      entry: latest,
    }),
    annotations: async (command) => {
      const reply = deferred<Outcome>();
      writes.push({ command, reply });
      return reply.promise;
    },
    sourceCorrection: async () => ({ kind: 'uncertain' }),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, {
          client,
          children: createElement(RichPrivateEntry, {
            subject: { id: entry.subjectId, label: 'Book' },
            session: { state: 'signed-in', subject: 'A', csrfToken: 'rotated-csrf' },
            admitted: true,
            returnTo: '/en/subjects/subject-1/book',
            entryGuard: currentGuard,
            origin: { lifetime, isCurrent: () => active, refreshEntry: async () => true },
            transport,
          }),
        }),
      ),
    );
    await act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
  };
  const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === name)!;
  const click = async (name: string) => {
    await act(async () => button(name).click());
  };
  const changeRank = async (value: string) => {
    const input = host.querySelector('input[type=number]')!;
    const key = Object.keys(input).find((key) => key.startsWith('__reactProps$'))!;
    const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!;
    await act(async () => props.onChange({ currentTarget: { value } }));
  };
  const reply = async (index: number, outcome: Outcome) => {
    await act(async () => {
      writes[index]!.reply.resolve(outcome);
      await new Promise((done) => setTimeout(done, 10));
    });
  };
  try {
    await render();
    const input = host.querySelector('input')!;
    input.focus();
    await changeRank('1');
    await click(m.library_rich_entry_save());
    expect(writes[0]!.command.data).toMatchObject({
      credential: 'captured-credential',
      csrfToken: 'captured-csrf',
      body: {
        revision: 4,
        entryGuard: guard,
        note: { op: 'unchanged' },
        priority: { op: 'set', value: 1 },
      },
    });
    expect(Object.keys(writes[0]!.command.data.body).sort()).toEqual(['entryGuard', 'note', 'priority', 'revision']);
    await reply(0, { kind: 'uncertain' });
    expect(button(m.library_rich_entry_save()).disabled).toBe(true);
    await click(m.library_rich_entry_retry());
    expect(writes[1]!.command).toEqual(writes[0]!.command);
    latest = { ...latest, note: 'new private note' };
    currentGuard = { ...guard, incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000002' };
    await render();
    await reply(1, { kind: 'conflict' });
    expect(window.document.activeElement).toBe(input);
    expect(host.textContent).toContain('new private note');
    expect(button(m.library_rich_entry_save()).disabled).toBe(true);
    await click(m.library_rich_entry_review_latest());
    await click(m.library_rich_entry_save());
    expect(writes[2]!.command.data.body).toMatchObject({
      revision: 4,
      entryGuard: currentGuard,
      note: { op: 'unchanged' },
    });
    expect(writes[2]!.command.data.key).not.toBe(writes[0]!.command.data.key);
    await reply(2, { kind: 'saved', entry: { ...latest, priority: 1, annotationRevision: 5 } });
    await click(m.library_rich_entry_clear_priority());
    await click(m.library_rich_entry_save());
    expect(writes[3]!.command.data.body.priority).toEqual({ op: 'clear' });
    active = false;
    await reply(3, { kind: 'saved', entry: { ...latest, note: 'LATE PRIVATE VALUE', priority: null } });
    expect(host.textContent).not.toContain('LATE PRIVATE VALUE');
    lifetime = 'returned-account';
    active = true;
    await render();
    await changeRank('2');
    await click(m.library_rich_entry_save());
    await act(async () => client.removeQueries({ queryKey: ['library', 'rich-private-entry'] }));
    await reply(4, { kind: 'saved', entry: { ...latest, note: 'REMOVED QUERY VALUE' } });
    expect(host.textContent).not.toContain('REMOVED QUERY VALUE');
    expect(host.querySelector('textarea')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    allow.mockRestore();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('native annotation writes keep the exact reviewed operands and definitive conflicts require review', async () => {
  const { writePrivateAnnotations } = await import('../src/library/rich-private-entry/native');
  const body = annotationWrite(entry, { note: entry.note!, priority: '1' }, guard)!;
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
});
