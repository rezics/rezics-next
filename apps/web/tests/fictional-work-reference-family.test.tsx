import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Authored UNRUN: actual production renderers and installed family, with illustrative
// native-shaped fixture transports. This is neither browser wrapping nor native proof.
test('Fictional work references share family parts and retain independent exact work editors and picker scopes', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en', width: 390 });
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
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
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
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { StoryArcProfile } = await import('../src/features/catalogue/story-arc-profile-view');
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { storyArcProfileFixture, storyArcProfileId } = await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { FictionalWorkReference } = await import('../src/features/catalogue/fictional-work-reference');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const { waitFor, within } = await import(require.resolve('@testing-library/dom'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const previousLocale = getLocale();
  const clients: QueryClient[] = [];
  const title = '星を渡る旅人たち — Die Reise durch die Sternenstadt — '.repeat(12);
  const destinations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor) {
      destinations.push(anchor.getAttribute('href')!);
      event.preventDefault();
    }
  });
  const button = (name: string) => within(host).getByRole('button', { name }) as HTMLButtonElement;
  const reference = () => host.querySelector<HTMLElement>('[data-slot="fictional-work-reference"]')!;
  const showNode = (node: ReactNode) => act(async () => root.render(node));
  try {
    setLocale('en', { reload: false });
    for (const kind of ['character', 'arc'] as const) {
      const character = characterProfileFixture();
      const arc = storyArcProfileFixture();
      const fixture = kind === 'character' ? character : arc;
      fixture.work.publicRead.subject.labels = { ja: title };
      const replacement = structuredClone(fixture.work.publicRead);
      replacement.subject.id = '00000000-0000-4000-8000-00000000f074';
      replacement.subject.labels = { en: 'A separately supplied replacement work' };
      const chooser = kind === 'character' ? m.character_choose_work() : m.story_arc_choose_work();
      const loads: { id?: string; work?: string }[] = [];
      const searches: { text: string; signal: AbortSignal }[] = [];
      const relationIds: string[] = [];
      let failure: 'denied' | 'unavailable' | undefined;
      let reader = 'original-reader';
      let session: 'signed-in' | 'signed-out' = 'signed-in';
      let useReplacement = false;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const characterTransport = {
        ...character.transport,
        load: async (address: Parameters<typeof character.transport.load>[0]) => {
          loads.push(address);
          if (failure) return { ok: false as const, reason: failure };
          const read = await character.transport.load({
            ...address,
            work: address.work ? character.work.id : undefined,
          });
          return read.ok && address.work === replacement.subject.id ? { ...read, work: replacement } : read;
        },
      };
      const arcTransport = {
        ...arc.transport,
        load: async (address: Parameters<typeof arc.transport.load>[0]) => {
          loads.push(address);
          if (failure) return { ok: false as const, reason: failure };
          const read = await arc.transport.load({ ...address, work: address.work ? arc.work.id : undefined });
          return read.ok && address.work === replacement.subject.id ? { ...read, work: replacement } : read;
        },
      };
      const search = async (text: string, signal: AbortSignal) => {
        searches.push({ text, signal });
        // Feed the real picker both an admitted work and the current non-work subject.
        // The production Character/Arc scope must exclude the latter, unchanged.
        const items = await fixture.props.search('', signal);
        return useReplacement
          ? items.map((item) =>
              item.id === fixture.work.id
                ? { ...item, id: replacement.subject.id, title: replacement.subject.labels.en! }
                : item,
            )
          : items;
      };
      const relations = (id: string) => {
        relationIds.push(id);
        return fixture.props.relations(id);
      };
      const show = () =>
        showNode(
          <QueryClientProvider client={client}>
            <CandidateReaderBoundary
              address={kind}
              observed={{ state: session, subject: reader, csrfToken: 'current-csrf' }}
            >
              {kind === 'character' ? (
                <CharacterProfile
                  {...character.props}
                  id={characterProfileId}
                  work={character.work.id}
                  locale="en"
                  session={session}
                  transport={characterTransport}
                  search={search}
                  relations={relations}
                />
              ) : (
                <StoryArcProfile
                  {...arc.props}
                  id={storyArcProfileId}
                  work={arc.work.id}
                  locale="en"
                  session={session}
                  transport={arcTransport}
                  search={search}
                  relations={relations}
                />
              )}
            </CandidateReaderBoundary>
          </QueryClientProvider>,
        );
      await show();
      await waitFor(() => expect(reference()).not.toBeNull());
      const row = reference();
      const primary = row.querySelector<HTMLAnchorElement>('h3[data-content-item-slot="title"] > a')!;
      const href = subjectHref({ id: fixture.work.id, label: title }, 'en').href;
      expect(primary.textContent).toBe(title);
      expect(primary.getAttribute('lang')).toBe('ja');
      expect(primary.getAttribute('href')).toBe(href);
      expect(primary.className).not.toContain('after:inset-0');
      expect(row.className).toContain('has-[:focus-visible]:before:opacity-100');
      expect(row.querySelector('[data-slot="list-row-link"]')).toBeNull();
      expect(row.querySelector('form, input, select')).toBeNull();
      expect(host.querySelector('a a, a button, a input, a select, a form')).toBeNull();
      const summary = row.querySelector<HTMLElement>('summary')!;
      expect(summary.textContent).toBe(m.fictional_work_technical_details());
      expect(row.querySelector('details')!.open).toBe(false);
      const codes = [...row.querySelectorAll<HTMLElement>('code')];
      expect(codes.map((code) => code.textContent)).toEqual([fixture.work.id, fixture.work.publicRead.subject.type]);
      for (const text of [primary, ...codes]) {
        expect(text.className).toContain('[overflow-wrap:anywhere]');
        expect(text.className).not.toMatch(/truncate|line-clamp/);
      }
      for (const code of codes) {
        expect(code.tabIndex).toBe(0);
        expect(code.className).toContain('select-text');
        expect(code.closest('a')).toBeNull();
      }
      const readCount = fixture.calls.length;
      primary.focus();
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(summary);
      await act(async () => user.keyboard('{Enter}'));
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(codes[0]);
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(codes[1]);
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(button(m.fictional_work_choose_another()));
      expect(fixture.calls.length).toBe(readCount);
      expect(searches).toEqual([]);
      const editors = row.parentElement!;
      const open = within(editors).getByRole('button', { name: m.relation_open() });
      expect(open.closest('[data-slot="fictional-work-reference"], a')).toBeNull();
      await act(async () => user.click(open));
      const property = await within(editors).findByRole('combobox', { name: m.relation_property() });
      const admitted = kind === 'character' ? 'wdt:P725' : 'rezics:storyArc';
      await act(async () => user.selectOptions(property, admitted));
      await show();
      expect(within(editors).getByRole('combobox', { name: m.relation_property() })).toBe(property);
      expect((property as HTMLSelectElement).value).toBe(admitted);
      expect(relationIds).toContain(fixture.work.id);
      expect(destinations).toEqual([]);
      await act(async () => user.click(primary));
      expect(destinations.pop()).toBe(href);

      // Repeated clear/replace reuses the existing picker callback and exact native work key.
      for (let round = 0; round < 2; round++) {
        await act(async () => user.click(button(m.fictional_work_choose_another())));
        const input = await within(host).findByRole('textbox', { name: chooser });
        expect(reference()).toBeNull();
        useReplacement = round === 1;
        await act(async () => user.type(input, 'work'));
        await waitFor(() => expect(within(window.document.body).getAllByRole('option')).toHaveLength(1));
        await act(async () => user.keyboard('{ArrowDown}{Enter}'));
        const expectedId = useReplacement ? replacement.subject.id : fixture.work.id;
        await waitFor(() => expect(reference()?.querySelector('code')?.textContent).toBe(expectedId));
        expect(loads.at(-1)?.work).toBe(expectedId);
        expect(relationIds.at(-1)).toBe(expectedId);
        expect(host.querySelectorAll('[data-slot="fictional-work-reference"]')).toHaveLength(1);
        expect(within(host).getAllByRole('button', { name: m.fictional_work_choose_another() })).toHaveLength(1);
        expect(within(host).queryByRole('textbox', { name: chooser })).toBeNull();
      }
      expect(searches.map(({ text }) => text)).toEqual(['work', 'work']);
      expect(searches.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);

      // A current supplied work without labels stays navigable without manufacturing a title.
      fixture.work.publicRead.subject.labels = {};
      reader = 'unlabelled-reader';
      await show();
      await waitFor(() => expect(reference()?.querySelector('a')?.textContent).toBe(m.subject_value_unlabelled()));
      expect(reference().querySelector('a')!.getAttribute('href')).toBe(
        subjectHref({ id: fixture.work.id, label: '' }, 'en').href,
      );
      session = 'signed-out';
      await show();
      await waitFor(() => expect(reference()).not.toBeNull());
      expect(reference().querySelector('button')).toBeNull();
      expect(within(host).queryByRole('button', { name: m.relation_open() })).toBeNull();

      // Real reader retirement drops the old payload and an actually denied source supplies no replacement.
      failure = 'denied';
      reader = 'replacement-reader';
      await show();
      await waitFor(() => expect(reference()).toBeNull());
      expect(host.innerHTML).not.toContain(title);
      expect(host.innerHTML).not.toContain(fixture.work.id);
      expect(host.innerHTML).not.toContain(replacement.subject.id);
      expect(within(host).queryByRole('textbox', { name: chooser })).toBeNull();
      expect(destinations).toEqual([]);
      failure = 'unavailable';
      reader = 'unavailable-reader';
      await show();
      await waitFor(() => expect(reference()).toBeNull());
      expect(host.innerHTML).not.toContain(fixture.work.id);
      expect(within(host).queryByRole('textbox', { name: chooser })).toBeNull();
      await showNode(null);
    }
    // Exercise exact unbroken supplied references beyond UUID length without a native-read claim.
    const fixture = characterProfileFixture();
    const exact = `urn:example:${'unbroken-reference'.repeat(24)}`;
    await showNode(<FictionalWorkReference subject={{ ...fixture.work.publicRead.subject, id: exact }} locale="en" />);
    expect(reference().querySelector('code')!.textContent).toBe(exact);
    expect(reference().querySelector('code')!.className).toContain('[overflow-wrap:anywhere]');
  } finally {
    await act(async () => root.unmount());
    for (const client of clients) client.clear();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
