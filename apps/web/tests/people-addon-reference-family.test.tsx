import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PeopleRead } from '../src/features/catalogue/people-profile';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';
import type { AddonRead } from '../src/features/catalogue/addon-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// UNRUN: actual React renderers with illustrative supplied reads. Happy DOM checks structure and
// containment classes at both widths; the canonical story plays own real browser geometry/keyboard proof.
// Neither fixture execution nor source typing establishes native, hydration, SSR or growth acceptance.
test('People credit and Addon base references share installed parts without changing reads, controls or disclosure lifetimes', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/people' });
  const extraReads: string[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => {
      extraReads.push(String(input));
      throw new Error('Reference presentation must not acquire data');
    }) as typeof fetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { RelationEditor } = await import('../src/features/catalogue/relation-editor');
  const { relationFields } = await import('../src/subject/relation-candidates');
  const { AddonProfile } = await import('../src/features/catalogue/addon-profile-view');
  const { peopleProfileFixture, peopleWorkId, peoplePersonId } =
    await import('../src/kernel/fake/catalogue-people-profile');
  const { addonProfileFixture, addonProfileId, addonWorkId } =
    await import('../src/kernel/fake/catalogue-addon-profile');
  const { addonType } = await import('../src/features/catalogue/addon-profile');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let client = new QueryClient();
  let generation = 0;
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (link) {
      event.preventDefault();
      navigations.push(link.getAttribute('href')!);
    }
  });
  type Session = 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  async function render(
    node: ReactNode,
    session: Session = 'signed-in',
    fresh = true,
    csrfToken = 'illustrative-token',
  ) {
    if (fresh) {
      await act(async () => root.render(null));
      client.clear();
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      generation++;
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{
              state: session,
              subject: session === 'signed-in' ? '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10' : null,
              csrfToken: session === 'signed-in' ? csrfToken : null,
            }}
            address={`reference-renderer:${generation}`}
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const frame = () => host.querySelector<HTMLElement>('[data-slot="profile-work-reference"]')!;
  const readingText = () => {
    const copy = host.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('details, [hidden]')) node.remove();
    return copy.textContent ?? '';
  };
  function containment(region: HTMLElement) {
    expect(region.className).toContain('min-w-0');
    expect(region.className).toContain('group relative isolate');
    for (const decoration of ['bg-card', 'border-border', 'rounded-xl'])
      expect(region.classList.contains(decoration)).toBe(false);
    expect(region.className).not.toMatch(/line-clamp|truncate/);
    for (const heading of region.querySelectorAll<HTMLElement>('[data-content-item-slot="title"]')) {
      expect(heading.className).toContain('min-w-0');
      expect(heading.className).not.toMatch(/line-clamp|truncate/);
    }
    for (const link of region.querySelectorAll('a')) {
      expect(link.querySelector('a, button, input, select, details')).toBeNull();
      expect(link.className).toContain('[overflow-wrap:anywhere]');
      expect(link.className).toContain('min-h-11');
      expect(link.className).toContain('min-w-11');
      expect(link.className).toContain('md:pointer-fine:min-h-8');
    }
  }
  async function references(details: HTMLDetailsElement, values: string[]) {
    expect(details.getAttribute('aria-label')).toContain(m.profile_work_reference_details());
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toBe(m.profile_work_reference_details());
    expect(summary.className).toContain('min-h-11');
    expect(summary.className).toContain('md:pointer-fine:min-h-8');
    await act(async () => user.click(summary));
    expect(details.open).toBe(true);
    const codes = [...details.querySelectorAll('code')];
    expect(codes.map((code) => code.textContent)).toEqual(values);
    for (const code of codes) {
      expect(code.tabIndex).toBe(0);
      expect(code.className).toContain('select-text');
      expect(code.className).toContain('whitespace-normal');
      expect(code.className).toContain('[overflow-wrap:anywhere]');
      expect(code.className).not.toMatch(/truncate|line-clamp|break-all/);
      code.focus();
      expect(window.document.activeElement).toBe(code);
    }
  }
  try {
    for (const width of [390, 1280]) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      host.style.width = `${width}px`;
      const person = peopleProfileFixture();
      const workTitle = `Shared 灯籠の歌 등불의노래 Chansons مرفأ ${'longunbrokentitle'.repeat(18)}`;
      person.work.subject.labels = { en: workTitle };
      const supplied = await person.transport.load();
      if (!supplied.ok) throw new Error('Expected supplied People reference');
      let peopleRead: PeopleRead = supplied;
      let peopleLoads = 0;
      const transport = {
        ...person.transport,
        load: async () => {
          peopleLoads++;
          return peopleRead;
        },
      };
      const people = (session: Session = 'signed-in') => (
        <PeopleProfileEditor
          work={peopleWorkId}
          locale="en"
          session={session}
          transport={transport}
          propose={person.propose}
          review={person.review}
          onNavigate={() => {}}
        />
      );
      await render(people());
      await waitFor(() => expect(frame()).not.toBeNull());
      const credit = frame();
      containment(credit);
      expect(within(credit).getByRole('heading', { level: 3, name: workTitle }).textContent).toBe(workTitle);
      const primary = within(credit).getByRole('link', { name: workTitle });
      const correction = within(credit).getByRole('link', { name: m.relation_title() });
      const href = subjectHref({ id: peopleWorkId, label: workTitle }, 'en').href;
      expect(primary.getAttribute('href')).toBe(href);
      expect(correction.getAttribute('href')).toBe(`${href}/relation-edit`);
      expect(readingText()).toContain(m.people_profile_credit_help());
      expect(credit.closest('section')?.querySelector('h2')?.textContent).toBe(m.people_profile_credit());
      primary.focus();
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(correction);
      await act(async () => user.keyboard('{Enter}'));
      expect(navigations.at(-1)).toBe(`${href}/relation-edit`);
      await act(async () => user.tab());
      expect(window.document.activeElement).toBe(credit.querySelector('summary'));
      const queries = client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey[0]);
      expect(queries.sort()).toEqual(['catalogue-create', 'people-profile']);
      await references(credit.querySelector('details')!, [peopleWorkId]);
      expect(peopleLoads).toBe(1);
      expect(host.querySelectorAll('form')).toHaveLength(1);
      expect(client.getQueryCache().getAll()).toHaveLength(2);

      for (const session of ['signed-out', 'unknown', 'unavailable'] as const) {
        await render(people(session), session);
        await waitFor(() => expect(host.querySelector('form')).not.toBeNull());
        expect(within(frame()).getByRole('link', { name: workTitle }).getAttribute('href')).toBe(href);
        expect(within(frame()).getByRole('link', { name: m.relation_title() }).getAttribute('href')).toBe(
          `${href}/relation-edit`,
        );
        expect(
          within(host).getByRole('textbox', { name: m.catalogue_create_label() }).closest('fieldset')?.disabled,
        ).toBe(true);
        expect(host.querySelectorAll('form')).toHaveLength(1);
        expect(readingText()).toContain(
          session === 'signed-out'
            ? m.catalogue_create_signed_out()
            : session === 'unavailable'
              ? m.catalogue_create_unavailable()
              : m.catalogue_create_loading(),
        );
      }

      peopleRead = { ...supplied, credits: [] };
      await render(people());
      await waitFor(() => expect(host.textContent).toContain(m.people_profile_no_credit()));
      expect(within(frame()).queryByRole('link', { name: m.relation_title() })).toBeNull();
      expect(within(frame()).getByRole('link', { name: workTitle }).getAttribute('href')).toBe(href);
      peopleRead = { ...supplied, work: null };
      await render(people());
      await waitFor(() => expect(within(host).queryByText(m.catalogue_create_loading())).toBeNull());
      expect(frame()).toBeNull();
      expect(host.innerHTML).not.toContain(peopleWorkId);
      expect(host.textContent).toContain(m.correction_stale());
      expect(host.querySelectorAll('form')).toHaveLength(0);

      const currentPerson = peopleProfileFixture('ready', 'en', 'person');
      const personTitle = `Mira 佐藤 미라 ${'langueSansEspaces'.repeat(18)}`;
      currentPerson.current.subject.labels = { en: personTitle };
      for (const session of ['signed-in', 'signed-out', 'unknown', 'unavailable'] as const) {
        await render(
          <PeopleProfileEditor
            id={peoplePersonId}
            locale="en"
            session={session}
            transport={currentPerson.transport}
            propose={currentPerson.propose}
            review={currentPerson.review}
            onNavigate={() => {}}
          />,
          session,
        );
        await waitFor(() => expect(host.textContent).toContain(personTitle));
        expect(frame()).toBeNull();
        expect(host.querySelectorAll('form')).toHaveLength(session === 'signed-in' ? 1 : 0);
        if (session !== 'signed-in')
          expect(readingText()).toContain(
            session === 'signed-out'
              ? m.catalogue_create_signed_out()
              : session === 'unavailable'
                ? m.catalogue_create_unavailable()
                : m.catalogue_create_loading(),
          );
      }

      const loaded = await currentPerson.transport.load();
      if (!loaded.ok || !loaded.public) throw new Error('Expected supplied current person');
      const currentRead = { ...loaded, public: loaded.public, work: currentPerson.work, credits: ['schema:author'] };
      const nested = {
        ok: true as const,
        public: currentRead.public,
        fields: relationFields(currentRead.release, 'schema:Person', 'en'),
        page: null,
        names: Object.fromEntries(
          Object.entries(currentRead.release.properties).map(([id, property]) => [id, property.labels]),
        ),
      };
      let personNext: PeopleRead | Error | Promise<PeopleRead> = currentRead;
      let relationReads = 0;
      const currentTransport = {
        ...currentPerson.transport,
        load: async () => {
          if (personNext instanceof Error) throw personNext;
          return await personNext;
        },
      };
      const commands: FactCommand[] = [];
      let finishProposal!: (result: FactResult) => void;
      const currentPage = () => (
        <PeopleProfileEditor
          id={peoplePersonId}
          locale="en"
          session="signed-in"
          transport={currentTransport}
          propose={async (command) => {
            command.session ??= 'original-credential';
            commands.push(command);
            return new Promise((resolve) => {
              finishProposal = resolve;
            });
          }}
          review={currentPerson.review}
          onNavigate={() => {}}
          relations={
            <RelationEditor
              id={peoplePersonId}
              locale="en"
              initial={nested}
              search={async () => []}
              transport={{
                read: async () => {
                  relationReads++;
                  return nested;
                },
                propose: async () => ({ ok: false, reason: 'unavailable' }),
                confirm: async () => ({ ok: false, reason: 'unavailable' }),
              }}
            />
          }
        />
      );
      const click = (name: string, scope = host) =>
        act(async () => user.click(within(scope).getByRole('button', { name })));
      const field = () =>
        within(host).getByRole('region', { name: currentRead.release.properties['schema:url']!.labels.en! });
      const value = () => within(field()).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
      const citation = () => within(host).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
      const retired = () => {
        for (const text of [
          personTitle,
          '佐藤ミラ',
          peoplePersonId,
          peopleWorkId,
          'Lantern Songs',
          'original-credential',
        ])
          expect(host.innerHTML).not.toContain(text);
        expect(host.querySelectorAll('input,select,textarea,a')).toHaveLength(0);
      };
      await render(currentPage());
      await waitFor(() => expect(host.querySelector('form')).not.toBeNull());
      await click(m.facts_edit_field(), field());
      await act(async () => {
        await user.clear(value());
        await user.type(value(), 'https://example.org/private');
      });
      await act(async () =>
        user.selectOptions(within(host).getByRole('combobox', { name: m.relation_property() }), nested.fields[0]!.id),
      );
      await act(async () => user.type(citation(), 'https://example.org/private-citation'));
      await click(m.facts_submit());
      expect(commands).toHaveLength(1);
      const exact = structuredClone(commands[0]!);
      const staleSubmit = within(host).getByRole('button', { name: m.facts_submit() });
      let finishPerson!: (read: PeopleRead) => void;
      personNext = new Promise((resolve) => {
        finishPerson = resolve;
      });
      await click(m.correction_reload());
      retired();
      await act(async () =>
        finishProposal({ ok: true, kind: 'proposed-awaiting-review', candidate: 'retired-candidate', revision: 2 }),
      );
      retired();
      await act(async () => finishPerson({ ok: false, reason: 'unavailable' }));
      await waitFor(() => expect(readingText()).toContain(m.correction_unavailable()));
      retired();
      const failures: (PeopleRead | Error)[] = [
        new Error('offline'),
        { ok: false, reason: 'denied' },
        { ok: false, reason: 'concealed' },
        {
          ...currentRead,
          public: { ...currentRead.public, subject: { ...currentRead.public.subject, id: crypto.randomUUID() } },
        },
        {
          ...currentRead,
          public: { ...currentRead.public, subject: { ...currentRead.public.subject, type: 'schema:Organization' } },
        },
        {
          ...currentRead,
          work: { ...currentRead.work, subject: { ...currentRead.work.subject, id: crypto.randomUUID() } },
        },
        { ...currentRead, release: { ...currentRead.release, types: {} } },
      ];
      for (const failure of failures) {
        personNext = failure;
        await click(m.correction_retry());
        await waitFor(() =>
          expect(within(host).getByRole('button', { name: m.correction_retry() }).hasAttribute('disabled')).toBe(false),
        );
        retired();
      }
      const recovered = structuredClone(currentRead);
      recovered.public.subject.labels = { en: 'Fresh Person', ja: '新しい名前' };
      recovered.public.subject.descriptions = { ja: '新しい説明' };
      recovered.public.subject.aliases = { ja: ['新しい別名'] };
      recovered.work.subject.labels.en = 'Fresh Work';
      nested.public = recovered.public;
      personNext = recovered;
      await click(m.correction_retry());
      await waitFor(() => expect(host.textContent).toContain('Fresh Person'));
      for (const text of ['新しい名前', '新しい説明', '新しい別名', 'Fresh Work'])
        expect(host.textContent).toContain(text);
      expect(host.innerHTML).not.toContain(personTitle);
      expect(host.innerHTML).not.toContain('retired-candidate');
      expect(frame().querySelector('a')?.getAttribute('href')).toBe(
        subjectHref({ id: peopleWorkId, label: 'Fresh Work' }, 'en').href,
      );
      expect(value().value).toBe('https://example.org/private');
      expect(citation().value).toBe('https://example.org/private-citation');
      expect(relationReads).toBeGreaterThan(0);
      await act(async () => staleSubmit.click());
      expect(commands).toHaveLength(1);
      await click(m.facts_submit());
      expect(commands[1]).toBe(commands[0]);
      expect(commands[1]).toEqual(exact);
      personNext = new Error('offline');
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['people-profile'] });
      });
      retired();
      personNext = recovered;
      await click(m.correction_retry());
      await render(currentPage(), 'signed-in', false, 'changed-session');
      await waitFor(() => expect(host.textContent).toContain('Fresh Person'));
      await act(async () =>
        finishProposal({ ok: true, kind: 'proposed-awaiting-review', candidate: 'old-session-candidate', revision: 3 }),
      );
      expect(host.innerHTML).not.toContain('old-session-candidate');
      expect(within(field()).queryByRole('textbox')).toBeNull();
      await act(async () =>
        user.selectOptions(within(host).getByRole('combobox', { name: m.relation_property() }), nested.fields[0]!.id),
      );
      expect(citation().value).toBe('');
      personNext = new Promise((resolve) => {
        finishPerson = resolve;
      });
      await click(m.correction_reload());
      retired();
      personNext = { ok: false, reason: 'unavailable' };
      await render(
        <PeopleProfileEditor
          id={peoplePersonId}
          locale="en"
          session="signed-out"
          transport={currentTransport}
          propose={currentPerson.propose}
          review={currentPerson.review}
          onNavigate={() => {}}
        />,
        'signed-out',
        false,
      );
      await act(async () => finishPerson(currentRead));
      await waitFor(() => expect(readingText()).toContain(m.correction_unavailable()));
      expect(host.innerHTML).not.toContain(personTitle);
      expect(host.querySelector('form')).toBeNull();

      const addon = addonProfileFixture();
      const addonTitle = `Shared Northern lights 北の光 북극광 ${'extensionSansEspaces'.repeat(18)}`;
      addon.current.subject.labels = { en: addonTitle };
      addon.work.subject.labels = { en: workTitle };
      const addonSupplied = await addon.transport.load({ id: addonProfileId, work: addonWorkId });
      if (!addonSupplied.ok) throw new Error('Expected supplied Addon references');
      let addonRead: AddonRead = addonSupplied;
      let addonLoads = 0;
      let searches = 0;
      const addonTransport = {
        ...addon.transport,
        load: async () => {
          addonLoads++;
          return addonRead;
        },
      };
      const addOn = (session: Session = 'signed-in', id: string | null = addonProfileId) => (
        <AddonProfile
          {...addon.props}
          id={id ?? undefined}
          work={addonWorkId}
          locale="en"
          session={session}
          transport={addonTransport}
          search={async (text, signal) => {
            searches++;
            return addon.props.search(text, signal);
          }}
        />
      );
      await render(addOn());
      await waitFor(() => expect(frame()).not.toBeNull());
      containment(frame());
      const identity = host.querySelector<HTMLElement>('[data-slot="profile-addon-reference"]')!;
      containment(identity);
      expect(within(identity).getByRole('heading', { level: 2, name: addonTitle }).textContent).toBe(addonTitle);
      expect(within(frame()).getByRole('heading', { level: 3, name: workTitle }).textContent).toBe(workTitle);
      expect(frame().closest('section')?.querySelector('h2')?.textContent).toBe(m.addon_base());
      expect(within(frame()).getByRole('link', { name: workTitle }).getAttribute('href')).toBe(
        subjectHref({ id: addonWorkId, label: workTitle }, 'en').href,
      );
      const publicLinks = within(host).getAllByRole('link', { name: m.candidate_view_public() });
      expect(publicLinks[0]!.getAttribute('href')).toBe(
        subjectHref({ id: addonProfileId, label: addonTitle }, 'en').href,
      );
      const details = host.querySelector<HTMLDetailsElement>('details[aria-label]')!;
      expect(readingText()).not.toContain(addonType);
      expect(readingText()).toContain(addonSupplied.release.types[addonType]!.labels.en!);
      await references(details, [addonType, addonProfileId, addonWorkId]);
      expect(host.querySelectorAll('form')).toHaveLength(1);
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey[0]),
      ).toEqual(['addon-profile']);
      expect(addonLoads).toBe(1);
      expect(searches).toBe(0);
      const controls = host.querySelectorAll('input, select, textarea, button').length;
      await act(async () => user.click(details.querySelector('summary')!));
      expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(controls);
      expect(addonLoads).toBe(1);

      // Same-address reload failure retains the original mounted correction tree, hidden by current-success.
      for (let attempt = 0; attempt < 2; attempt++) {
        addonRead = { ok: false, reason: attempt ? 'denied' : 'unavailable' };
        await act(async () => user.click(within(host).getAllByRole('button', { name: m.correction_reload() }).at(-1)!));
        await waitFor(() => expect(frame().closest('[hidden]')).not.toBeNull());
        expect(within(host).queryByRole('heading', { name: addonTitle })).toBeNull();
        expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(controls);
        expect(readingText()).toContain(attempt ? m.correction_denied() : m.correction_unavailable());
        addonRead = addonSupplied;
        await act(async () => user.click(within(host).getAllByRole('button', { name: m.correction_reload() }).at(-1)!));
        await waitFor(() => expect(frame().closest('[hidden]')).toBeNull());
        expect(host.querySelectorAll('form')).toHaveLength(1);
      }

      for (const session of ['signed-out', 'unknown', 'unavailable'] as const) {
        await render(addOn(session), session, false);
        await waitFor(() => expect(frame()).not.toBeNull());
        expect(host.querySelector('form')).not.toBeNull();
        expect(host.querySelector('form')?.closest('[hidden]')).not.toBeNull();
        expect(within(host).queryByRole('button', { name: m.facts_submit() })).toBeNull();
        expect(within(frame()).getByRole('link', { name: workTitle })).toBeDefined();
      }
      // A retired reader cannot reinsert even a late successful response, including closed details/attributes.
      let finish!: (read: AddonRead) => void;
      const pending = new Promise<AddonRead>((resolve) => {
        finish = resolve;
      });
      await render(
        <AddonProfile
          {...addon.props}
          id={addonProfileId}
          work={addonWorkId}
          locale="en"
          transport={{ ...addon.transport, load: () => pending }}
        />,
      );
      addonRead = { ok: false, reason: 'denied' };
      await render(addOn('signed-out'), 'signed-out', false);
      await act(async () => finish(addonSupplied));
      await waitFor(() => expect(host.textContent).toContain(m.correction_denied()));
      for (const value of [addonTitle, workTitle, addonProfileId, addonWorkId])
        expect(host.innerHTML).not.toContain(value);
      expect(frame()).toBeNull();

      addonRead = { ...addonSupplied, public: null, work: null };
      await render(addOn('signed-in', null));
      await waitFor(() =>
        expect(within(host).getByRole('combobox', { name: m.addon_choose_existing() })).toBeDefined(),
      );
      expect(frame()).toBeNull();
      expect(host.querySelectorAll('form')).toHaveLength(1);
      expect(host.querySelector('[data-slot="profile-addon-reference"]')).toBeNull();
      expect(searches).toBe(0);
      const choose = within(host).getByRole('combobox', { name: m.addon_choose_existing() });
      await act(async () => user.type(choose, 'Shared'));
      await waitFor(() => expect(within(window.document.body).getByRole('listbox')).toBeDefined());
      const choices = within(within(window.document.body).getByRole('listbox'));
      expect(choices.getAllByRole('option')).toHaveLength(1);
      expect(choices.getByRole('option').textContent).toContain(addonTitle);
      expect(choices.getByRole('option').textContent).not.toContain(workTitle);
      addonRead = addonSupplied;
      await act(async () => {
        await user.keyboard('{ArrowDown}{Enter}');
      });
      await waitFor(() => expect(host.querySelector('[data-slot="profile-addon-reference"]')).not.toBeNull());
      expect(within(host).queryByRole('combobox', { name: m.addon_choose_existing() })).toBeNull();
      expect(host.querySelectorAll('form')).toHaveLength(1);

      addonRead = { ...addonSupplied, public: null, work: null };
      await render(addOn('signed-in', null));
      await waitFor(() =>
        expect(within(host).getByRole('textbox', { name: m.catalogue_create_label() })).toBeDefined(),
      );
      await act(async () =>
        user.type(within(host).getByRole('textbox', { name: m.catalogue_create_label() }), 'New add-on'),
      );
      await act(async () => user.click(within(host).getByRole('button', { name: m.catalogue_create_submit() })));
      await waitFor(() => expect(within(host).getByRole('link', { name: m.addon_correct() })).toBeDefined());
      const continuation = within(host).getByRole('link', { name: m.addon_correct() });
      expect(continuation.getAttribute('href')).toMatch(/\/new-add-on\/addon$/);
      expect(continuation.parentElement?.closest('a')).toBeNull();
      expect(addon.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    }
    expect(extraReads).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 30_000);
