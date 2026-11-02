import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { PeopleRead } from '../src/features/catalogue/people-profile';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('People recovery replaces complete public context while retaining private drafts and exact retry credentials', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/people' });
  const globals = {
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLSelectElement',
        'Element',
        'Node',
        'MutationObserver',
        'ResizeObserver',
        'Document',
        'DocumentFragment',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { RelationEditor } = await import('../src/features/catalogue/relation-editor');
  const { relationFields } = await import('../src/subject/relation-candidates');
  const { peopleProfileFixture, peoplePersonId, peopleWorkId } =
    await import('../src/kernel/fake/catalogue-people-profile');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = peopleProfileFixture('ready', 'en', 'person');
  const loaded = await fixture.transport.load();
  if (!loaded.ok || !loaded.public) throw new Error('Expected Person');
  const initial = { ...loaded, public: loaded.public, work: fixture.work, credits: ['schema:author'] };
  const nestedRead = {
    ok: true as const,
    public: initial.public,
    fields: relationFields(initial.release, 'schema:Person', 'en'),
    names: Object.fromEntries(
      Object.entries(initial.release.properties).map(([id, property]) => [id, property.labels]),
    ),
    page: null,
  };
  let outcome: PeopleRead | Error | Promise<PeopleRead> = initial;
  let loads = 0,
    relationReads = 0;
  let finishProposal!: (result: FactResult) => void;
  const commands: FactCommand[] = [];
  const transport = {
    ...fixture.transport,
    load: async () => {
      loads++;
      if (outcome instanceof Error) throw outcome;
      return await outcome;
    },
  };
  const propose = async (command: FactCommand): Promise<FactResult> => {
    command.session ??= 'original-credential';
    commands.push(command);
    return new Promise((resolve) => {
      finishProposal = resolve;
    });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const click = (name: string, scope = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const show = (csrfToken = 'first', subject = 'viewer') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary observed={{ state: 'signed-in', subject, csrfToken }} address={peoplePersonId}>
            <PeopleProfileEditor
              id={peoplePersonId}
              locale="en"
              session="signed-in"
              transport={transport}
              propose={propose}
              review={fixture.review}
              onNavigate={() => {}}
              relations={
                <RelationEditor
                  id={peoplePersonId}
                  locale="en"
                  initial={nestedRead}
                  search={async () => []}
                  transport={{
                    read: async () => {
                      relationReads++;
                      return nestedRead;
                    },
                    propose: async () => ({ ok: false, reason: 'unavailable' }),
                    confirm: async () => ({ ok: false, reason: 'unavailable' }),
                  }}
                />
              }
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const field = () => within(host).getByRole('region', { name: initial.release.properties['schema:url']!.labels.en! });
  const value = () => within(field()).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
  const citation = () => within(host).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
  const retired = () => {
    for (const text of ['Mira Sato', '佐藤ミラ', 'Lantern Songs', peoplePersonId, peopleWorkId, 'original-credential'])
      expect(host.innerHTML).not.toContain(text);
    expect(host.querySelectorAll('input,select,textarea,a')).toHaveLength(0);
  };
  try {
    await show();
    await settle();
    await click(m.facts_edit_field(), field());
    await act(async () => {
      await user.clear(value());
      await user.type(value(), 'https://example.org/private');
    });
    await act(async () => user.type(citation(), 'https://example.org/private-citation'));
    await click(m.facts_submit());
    expect(commands).toHaveLength(1);
    const exact = structuredClone(commands[0]!);
    const staleSubmit = within(host).getByRole('button', { name: m.facts_submit() });
    let finishRead!: (read: PeopleRead) => void;
    outcome = new Promise((resolve) => {
      finishRead = resolve;
    });
    await click(m.correction_reload());
    retired();
    await settle(() =>
      finishProposal({ ok: true, kind: 'proposed-awaiting-review', candidate: 'retired-candidate', revision: 2 }),
    );
    retired();
    await settle(() => finishRead({ ok: false, reason: 'denied' }));
    retired();
    const failures: (PeopleRead | Error)[] = [
      new Error('offline'),
      { ok: false, reason: 'concealed' },
      { ...initial, public: { ...initial.public, subject: { ...initial.public.subject, id: crypto.randomUUID() } } },
      {
        ...initial,
        public: { ...initial.public, subject: { ...initial.public.subject, type: 'schema:Organization' } },
      },
      { ...initial, work: { ...fixture.work, subject: { ...fixture.work.subject, id: crypto.randomUUID() } } },
      { ...initial, release: { ...initial.release, types: {} } },
    ];
    for (const failure of failures) {
      outcome = failure;
      await click(m.correction_retry());
      await settle();
      retired();
    }
    const recovered = structuredClone(initial);
    recovered.public.subject.labels = { en: 'Fresh Person', ja: '新しい名前' };
    recovered.public.subject.descriptions = { ja: '新しい説明' };
    recovered.public.subject.aliases = { ja: ['新しい別名'] };
    recovered.work.subject.labels.en = 'Fresh Work';
    outcome = recovered;
    await click(m.correction_retry());
    await settle();
    for (const text of ['Fresh Person', '新しい名前', '新しい説明', '新しい別名', 'Fresh Work'])
      expect(host.textContent).toContain(text);
    expect(host.innerHTML).not.toContain('retired-candidate');
    expect(host.innerHTML).not.toContain('Mira Sato');
    expect(host.querySelector('[data-slot="profile-work-reference"] a')?.getAttribute('href')).toBe(
      subjectHref({ id: peopleWorkId, label: 'Fresh Work' }, 'en').href,
    );
    expect(value().value).toBe('https://example.org/private');
    expect(citation().value).toBe('https://example.org/private-citation');
    expect(relationReads).toBeGreaterThan(0);
    await settle(() => staleSubmit.click());
    expect(commands).toHaveLength(1);
    await click(m.facts_submit());
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]).toEqual(exact);
    // A thrown query refetch retains data in the cache, but cannot retain display authority.
    outcome = new Error('offline');
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['people-profile'] });
    });
    await settle();
    retired();
    outcome = recovered;
    await click(m.correction_retry());
    await settle();
    await show('second');
    await settle();
    await settle(() =>
      finishProposal({ ok: true, kind: 'proposed-awaiting-review', candidate: 'old-session-candidate', revision: 3 }),
    );
    expect(host.innerHTML).not.toContain('old-session-candidate');
    expect(within(field()).queryByRole('textbox')).toBeNull();
    expect(citation().value).toBe('');
    let lateRead!: (read: PeopleRead) => void;
    outcome = new Promise((resolve) => {
      lateRead = resolve;
    });
    await click(m.correction_reload());
    retired();
    outcome = recovered;
    await show('second', 'another-viewer');
    await settle();
    await settle(() => lateRead(initial));
    expect(host.textContent).toContain('Fresh Person');
    expect(host.innerHTML).not.toContain('Mira Sato');
    expect(within(field()).queryByRole('textbox')).toBeNull();
    expect(citation().value).toBe('');
    expect(loads).toBe(14);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
