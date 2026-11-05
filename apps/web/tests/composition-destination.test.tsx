import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  fromMarkdown,
  fromPlainText,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { NewThreadPageResult } from '../src/threads/new-thread-read';
import type { ThreadCreationReaderAdmission } from '../src/threads/thread-creation-lifetime';
import type { CurrentReviewVote } from '../src/threads/review-vote';
import {
  createCompositionDestinationReader,
  type CompositionDestinationProjection,
} from '../src/threads/composition-destination';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const realmId = id(1);
const subjectId = id(40);
const vote: CurrentReviewVote = { questionId: '00000000-0000-7000-8000-000000000001', units: 14, revision: 8 };

type Rules = NonNullable<NewThreadPageResult['board']['community']>['rules'];
type Board = NewThreadPageResult['board'];

function rules(body: DocumentSnapshot, revision = 50) {
  return {
    state: 'available' as const,
    value: {
      postId: id(60),
      revisionId: id(revision),
      body,
      licence: 'CC-BY-4.0',
      sha256: String(revision).padStart(64, '0'),
    },
  };
}

function community(ruleSlot: Rules) {
  return {
    realmId,
    spaceId: id(2),
    contextId: id(3),
    name: 'Atlas Readers',
    description: '',
    avatar: { state: 'none' as const, value: null },
    banner: { state: 'none' as const, value: null },
    members: { state: 'unknown' as const, count: null, version: null },
    rules: ruleSlot,
    join: { membership: 'unknown' as const, action: null },
  };
}

function boardFor(
  purpose: 'discussion' | 'reviews',
  ruleSlot: Rules,
  boardId = id(10),
  title = 'Reading board',
): Board {
  return {
    id: boardId,
    realmId,
    community: community(ruleSlot),
    route: 0,
    title,
    purpose,
    visibility: 'protected',
    securityRevision: '1',
    availability: 'available',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as Board;
}

function availableRules(projection: CompositionDestinationProjection) {
  if (projection.community.state !== 'available' || projection.community.rules.state !== 'available')
    throw new Error('Expected current community rules');
  return projection.community.rules.value;
}

test('the existing board response keeps Global, producer, rules and revision states distinct', () => {
  const reader = createCompositionDestinationReader();
  const body = fromPlainText('Local rules', 'text');
  const global = reader.read({ ...boardFor('discussion', rules(body)), realmId: null } as Board);
  expect(global.community).toEqual({ state: 'global' });
  expect(global.rulesIdentity).toBeUndefined();

  const missingProducer = { ...boardFor('discussion', rules(body)) } as Record<string, unknown>;
  delete missingProducer.community;
  expect(reader.read(missingProducer as Board).community).toEqual({ state: 'unavailable' });
  expect(reader.read(boardFor('discussion', { state: 'none', value: null })).community.state).toBe('available');
  expect(reader.read(boardFor('discussion', { state: 'unavailable', value: null } as Rules)).community.state).toBe(
    'available',
  );
  expect(availableRules(reader.read(boardFor('discussion', rules(body)))).revisionId).toBe(id(50));
});

test('text rules obey the serialized byte bound and keep one bounded revision outline', () => {
  const reader = createCompositionDestinationReader();
  const overhead = new TextEncoder().encode(serializeDocument(fromPlainText('', 'text'))).length;
  for (const size of [1024, 16 * 1024, 64 * 1024]) {
    const body = fromPlainText('x'.repeat(size - overhead), 'text');
    expect(new TextEncoder().encode(serializeDocument(body)).length).toBe(size);
    expect(availableRules(reader.read(boardFor('discussion', rules(body)))).body).toBe(body);
  }
  const emojiAndCjk = fromPlainText('😀漢字'.repeat(100), 'text');
  expect(availableRules(reader.read(boardFor('discussion', rules(emojiAndCjk)))).body).toBe(emojiAndCjk);
  const tooLarge = fromPlainText('x'.repeat(64 * 1024 + 1 - overhead), 'text');
  expect(reader.read(boardFor('discussion', rules(tooLarge))).community.state).toBe('unavailable');
  expect(
    reader.read(boardFor('discussion', rules(fromPlainText('not a text profile', 'blocks')))).community.state,
  ).toBe('unavailable');

  const headings = Array.from({ length: 103 }, () => '# Repeated heading').join('\n\n');
  const longList = Array.from({ length: 250 }, (_, index) => `- ${'LongListItem'.repeat(8)} ${index}`).join('\n');
  const outlineBody = fromMarkdown(`${headings}\n\n${longList}`, 'text');
  const firstBoard = boardFor('discussion', rules(outlineBody, 51));
  const first = reader.read(firstBoard);
  expect(first.outline?.entries).toHaveLength(100);
  expect(first.outline?.entries[0]?.label).toBe(first.outline?.entries[1]?.label);
  expect(first.outline?.omitted).toBe(3);
  expect(reader.read(firstBoard)).toBe(first);

  const refreshed = boardFor('discussion', rules(outlineBody, 51, 'Revalidation copy'));
  const sameRevision = reader.read(refreshed);
  expect(sameRevision.outline).toBe(first.outline);
  expect(availableRules(sameRevision).body).toBe(outlineBody);
  const malformed = structuredClone(fromPlainText('x', 'text')) as DocumentSnapshot;
  let nested: DocumentNode = { type: 'unknown-deep-node', content: [] };
  for (let index = 0; index < 80; index++)
    nested = { type: 'blockquote', attrs: { id: id(index + 100) }, content: [nested] };
  malformed.doc.content = [nested];
  expect(reader.read(boardFor('discussion', rules(malformed))).community.state).toBe('unavailable');
});

async function mountComposition(purpose: 'discussion' | 'reviews') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 900 });
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
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    { sessionQuery },
    { setLocale },
    { m },
    lifetime,
    route,
    actions,
    voteRead,
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/session/query'),
    import('../src/paraglide/runtime.js'),
    import('../src/paraglide/messages.js'),
    import('../src/threads/thread-creation-lifetime'),
    import('../src/routes/boards/$id_.new'),
    import('../src/threads/actions'),
    import('../src/threads/review-vote-read'),
  ]);
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = { state: 'signed-in' as const, subject: subjectId, csrfToken: 'current-csrf' };
  queryClient.setQueryData(sessionQuery.queryKey, owner);
  const readerAdmission: ThreadCreationReaderAdmission = {
    observation: lifetime.observeThreadCreationReader(queryClient)!,
    actualSubject: subjectId,
  };
  const startThread = spyOn(actions, 'startThread').mockImplementation(async () => {
    throw new Error('The rules panel must not submit.');
  });
  const voteReads: string[] = [];
  const voteReadSpy = spyOn(voteRead, 'readCurrentReviewVote').mockImplementation(({ data }) => {
    voteReads.push(data.subjectId);
    return Promise.resolve(vote);
  });
  const Composition = route.NewThreadComposition;
  let props = {
    board: boardFor(purpose, rules(fromPlainText('First revision text.', 'text'))),
    idempotencyKey: id(70),
    readerAdmission,
    presetSubject: id(71),
    presetSubjectTitle: 'Preset subject handoff',
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  function Page() {
    return (
      <QueryClientProvider client={queryClient}>
        <Composition {...props} />
      </QueryClientProvider>
    );
  }
  const render = async () => act(async () => root.render(<Page />));
  await render();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    host,
    window,
    user,
    m,
    owner,
    queryClient,
    sessionQuery,
    voteReads,
    startThread,
    voteReadSpy,
    render,
    props: () => props,
    replaceBoard: (board: Board, idempotencyKey: string) => {
      props = { ...props, board, idempotencyKey };
    },
    dispose: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      startThread.mockRestore();
      voteReadSpy.mockRestore();
    },
  };
}

for (const purpose of ['discussion', 'reviews'] as const) {
  test(`${purpose} composition inspects current rules without changing its draft or intent`, async () => {
    const page = await mountComposition(purpose);
    try {
      const { host, m, user } = page;
      const flush = async () =>
        act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      const title = host.querySelector<HTMLInputElement>('#thread-title')!;
      const editor = host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]')!;
      const key = host.querySelector<HTMLInputElement>('input[name="idempotency_key"]')!;
      expect(title).not.toBeNull();
      expect(editor).not.toBeNull();
      const originalKey = key.value;
      await act(async () => {
        await user.type(title, 'Keep this title');
        await user.type(editor, 'Keep this exact unsent draft.');
      });
      if (purpose === 'reviews') {
        await flush();
        const citation = host.querySelector<HTMLElement>('[role="checkbox"]');
        expect(citation).not.toBeNull();
        await act(async () => user.click(citation!));
        expect(citation?.getAttribute('aria-checked')).toBe('true');
      }
      expect(host.textContent).toContain('Preset subject handoff');
      const readsBeforeOpen = page.voteReads.length;
      const inspectButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === m.composition_destination_inspect_rules(),
      );
      expect(inspectButton).not.toBeNull();
      await act(async () => user.click(inspectButton!));
      expect(host.querySelector('[data-slot="composition-rules-reader"]')?.textContent).toContain(
        'First revision text.',
      );
      const close = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === m.composition_rules_reader_close(),
      )!;
      await act(async () => user.click(close));
      expect(page.window.document.activeElement).toBe(inspectButton);
      expect(title.value).toBe('Keep this title');
      expect(editor.textContent).toContain('Keep this exact unsent draft.');
      expect(key.value).toBe(originalKey);
      expect(host.textContent).toContain('Preset subject handoff');
      if (purpose === 'reviews') {
        expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
        expect(page.voteReads).toHaveLength(readsBeforeOpen);
      }
      expect(page.startThread).not.toHaveBeenCalled();

      const oldRules = 'First revision text.';
      const refreshed = boardFor(
        purpose,
        rules(fromPlainText('Second current revision.', 'text'), 52),
        id(10),
        'Current title',
      );
      page.replaceBoard(refreshed, id(99));
      await page.render();
      expect(host.querySelector('[data-slot="composition-rules-reader"]')).toBeNull();
      expect(host.querySelector('[data-slot="composition-destination"]')?.textContent).toContain(
        m.composition_destination_rules_changed(),
      );
      expect(host.querySelector('[data-slot="composition-destination"]')?.textContent).not.toContain(oldRules);
      expect(title.value).toBe('Keep this title');
      expect(editor.textContent).toContain('Keep this exact unsent draft.');
      expect(key.value).toBe(originalKey);
      expect(host.textContent).toContain('Preset subject handoff');
      if (purpose === 'reviews')
        expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');

      const inspectCurrent = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === m.composition_destination_inspect_rules(),
      )!;
      await act(async () => user.click(inspectCurrent));
      expect(host.querySelector('[data-slot="composition-rules-reader"]')?.textContent).toContain(
        'Second current revision.',
      );
      expect(host.querySelector('[data-slot="composition-rules-reader"]')?.textContent).not.toContain(oldRules);

      const staleClose = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === m.composition_rules_reader_close(),
      )!;
      page.queryClient.setQueryData(page.sessionQuery.queryKey, { ...page.owner, csrfToken: 'replacement-csrf' });
      await flush();
      expect(host.querySelector('[data-slot="composition-destination"]')).toBeNull();
      expect(host.textContent).not.toContain('Second current revision.');
      await act(async () => staleClose.click());
      expect(page.startThread).not.toHaveBeenCalled();
    } finally {
      await page.dispose();
    }
  });
}
