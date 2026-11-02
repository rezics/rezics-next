import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, Profiler } from 'react';
import type { FactCommand, FactsCurrent, FactResult } from '../src/features/catalogue/subject-facts';
import type { EditorRead } from '../src/features/catalogue/statement-editor';
import type { AlbumCommand, AlbumRead } from '../src/features/catalogue/album-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('Album recovery retires every current surface and retains private drafts and exact unresolved proposals', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/album' });
  const globals = {
    window,
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
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture, albumId, artistId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = albumFixture();
  const properties = ['album:confirmed', 'album:uncertain', 'album:private'];
  for (const property of properties) {
    fixture.release.properties[property] = {
      ...fixture.release.properties['schema:inLanguage']!,
      labels: { en: property },
    };
    fixture.release.types['schema:MusicAlbum']!.properties.push(property);
    fixture.publicRead.subject.statements[property] = [
      {
        ...structuredClone(fixture.publicRead.subject.statements['schema:datePublished']![0]!),
        id: crypto.randomUUID(),
        property: { id: property, data_type: 'string' },
        value: { type: 'value', content: 'en' },
      },
    ];
  }
  const initial = await fixture.loadCorrection();
  const current = await fixture.editors.facts.read();
  if (!current.ok) throw new Error('Expected Album');
  let next: EditorRead | Error | Promise<EditorRead> = current;
  let lateProposal: ((result: FactResult) => void) | undefined;
  const commands: FactCommand[] = [];
  let relationReads = 0;
  const editors = {
    ...fixture.editors,
    facts: {
      read: async () => {
        if (next instanceof Error) throw next;
        return await next;
      },
      propose: async (command: FactCommand): Promise<FactResult> => {
        commands.push(command);
        if (command.statement.property.id === properties[0]) return fixture.editors.facts.propose(command);
        command.session ??= 'original-native-session';
        return new Promise((resolve) => {
          lateProposal = resolve;
        });
      },
    },
    relations: {
      ...fixture.editors.relations,
      read: async (...args: Parameters<typeof fixture.editors.relations.read>) => {
        relationReads++;
        return fixture.editors.relations.read(...args);
      },
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  const click = (name: string, scope = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const retainedChange = (control: HTMLInputElement | HTMLTextAreaElement) => {
    const key = Object.getOwnPropertyNames(control).find((name) => name.startsWith('__reactProps$'));
    const callback =
      key &&
      (control as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[key]
        ?.onChange;
    if (!callback) throw new Error('Expected a mounted term edit callback');
    return callback;
  };
  const field = (property: string) => within(host).getByRole('region', { name: property });
  const show = (csrfToken = 'first', subject = 'viewer') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary observed={{ state: 'signed-in', subject, csrfToken }} address={albumId}>
            <AlbumProfile
              id={albumId}
              locale="en"
              session="signed-in"
              transport={{ ...fixture.transport, load: async () => initial }}
              search={async () => []}
              editors={editors}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const retired = () => {
    for (const text of ['Harbour', albumId, '2024', 'example.test', 'original-native-session'])
      expect(host.innerHTML).not.toContain(text);
    expect(host.querySelectorAll('input,select,textarea,a')).toHaveLength(0);
  };
  try {
    // Initial recovery has no private holder: only the admitted request owns result focus.
    const outside = window.document.createElement('button');
    window.document.body.append(outside);
    for (const scenario of ['throw', 'failure', 'missing', 'profile', 'address', 'viewer']) {
      let loads = 0;
      let nextInitial: AlbumRead | Error | Promise<AlbumRead> =
        scenario === 'throw'
          ? new Error('initial offline')
          : scenario === 'missing'
            ? { ok: true, release: { ...fixture.release, types: {} }, public: null }
            : { ok: false, reason: 'unavailable' };
      const initialTransport = {
        ...fixture.transport,
        load: async () => {
          loads++;
          if (nextInitial instanceof Error) throw nextInitial;
          return await nextInitial;
        },
      };
      const showInitial = (id = scenario === 'profile' ? albumId : undefined, viewer = 'viewer') =>
        act(async () =>
          root.render(
            <QueryClientProvider client={client}>
              <CandidateReaderBoundary
                observed={{ state: 'signed-in', subject: viewer, csrfToken: scenario }}
                address={id ?? 'initial-create'}
              >
                <AlbumProfile
                  id={id}
                  locale="en"
                  session="signed-in"
                  transport={initialTransport}
                  search={async () => []}
                  editors={fixture.editors}
                />
              </CandidateReaderBoundary>
            </QueryClientProvider>,
          ),
        );
      outside.focus();
      await showInitial();
      await settle();
      expect(window.document.activeElement).toBe(outside);
      const retry = within(host).getByRole('button', {
        name: scenario === 'missing' ? m.correction_reload() : m.correction_retry(),
      });
      const props = Reflect.get(
        retry,
        Object.keys(retry).find((key) => key.startsWith('__reactProps$'))!,
      );
      const staleRetry = () => props.onClick({ currentTarget: retry });
      let finishInitial!: (read: AlbumRead) => void;
      nextInitial = new Promise((resolve) => {
        finishInitial = resolve;
      });
      await settle(() => {
        staleRetry();
        staleRetry();
      });
      expect(loads).toBe(2);
      expect(
        within(host)
          .getAllByRole('status')
          .map((node) => node.textContent),
      ).toEqual([m.candidate_loading()]);
      expect(within(host).queryByRole('alert')).toBeNull();
      expect(within(host).queryByRole('button', { name: m.correction_retry() })).toBeNull();
      expect(within(host).queryByRole('button', { name: m.correction_reload() })).toBeNull();
      expect(host.querySelector('form')).toBeNull();
      const recovered: AlbumRead = { ok: true, release: fixture.release, public: fixture.publicRead };
      if (scenario === 'address' || scenario === 'viewer') {
        nextInitial = recovered;
        await showInitial(
          scenario === 'address' ? albumId : undefined,
          scenario === 'viewer' ? 'fresh-viewer' : 'viewer',
        );
        await settle();
        outside.focus();
        await settle(() => {
          finishInitial(recovered);
          staleRetry();
        });
        expect(loads).toBe(3);
        expect(window.document.activeElement).toBe(outside);
        continue;
      }
      if (scenario === 'throw') {
        await settle(() => finishInitial({ ok: false, reason: 'denied' }));
        const failure = within(host).getByRole('alert');
        expect(window.document.activeElement).toBe(failure.parentElement);
        await settle(staleRetry);
        expect(loads).toBe(2);
        nextInitial = recovered;
        await click(m.correction_retry());
        await settle();
      } else await settle(() => finishInitial(recovered));
      expect(window.document.activeElement).toBe(within(host).getByRole('heading', { level: 1 }));
      expect(host.querySelector('form')).not.toBeNull();
      const completedLoads = loads;
      await settle(staleRetry);
      expect(loads).toBe(completedLoads);
    }
    await show();
    await settle();
    for (const property of properties) {
      await click(m.facts_edit_field(), field(property));
      const input = within(field(property)).getByRole('textbox', { name: m.correction_value() });
      await act(async () => {
        await user.clear(input);
        await user.type(input, 'fr');
      });
    }
    await act(async () => user.click(within(field(properties[2]!)).getByRole('checkbox')));
    await click(m.facts_submit());
    expect(commands).toHaveLength(2);
    const exact = structuredClone(commands[1]!);
    await act(async () => user.click(within(field(properties[0]!)).getByRole('link', { name: m.correction_review() })));
    await settle();
    expect(host.textContent).toContain(m.candidate_current());
    const staleSubmit = within(host).getByRole('button', { name: m.facts_submit() });
    let finishRead!: (read: EditorRead) => void;
    next = new Promise((resolve) => {
      finishRead = resolve;
    });
    await click(m.correction_reload());
    retired();
    await settle(() =>
      lateProposal!({ ok: true, kind: 'proposed-awaiting-review', candidate: 'retired-candidate', revision: 2 }),
    );
    await settle(() => finishRead({ ok: false, reason: 'denied' }));
    retired();
    for (const failure of [
      new Error('offline'),
      { ok: false, reason: 'unavailable' },
      { ...current, public: { ...current.public, subject: { ...current.public.subject, id: crypto.randomUUID() } } },
      { ...current, public: { ...current.public, subject: { ...current.public.subject, type: 'schema:Book' } } },
      { ...current, release: { ...current.release, types: {} } },
    ] as (EditorRead | Error)[]) {
      next = failure;
      await click(m.correction_retry());
      retired();
    }
    const recovered: FactsCurrent = structuredClone(current);
    recovered.public.subject.labels.en = 'Fresh Album';
    fixture.publicRead.subject.labels.en = 'Fresh Album';
    next = recovered;
    await click(m.correction_retry());
    await settle();
    expect(host.textContent).toContain('Fresh Album');
    expect(host.innerHTML).not.toContain('retired-candidate');
    expect(relationReads).toBeGreaterThan(0);
    expect(
      (within(field(properties[2]!)).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement).value,
    ).toBe('fr');
    await settle(() => staleSubmit.click());
    expect(commands).toHaveLength(2);
    await click(m.facts_submit());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toBe(commands[1]);
    expect(commands[2]).toEqual(exact);
    await show('second');
    await settle();
    await settle(() =>
      lateProposal!({ ok: true, kind: 'proposed-awaiting-review', candidate: 'old-session-candidate', revision: 3 }),
    );
    expect(host.innerHTML).not.toContain('old-session-candidate');
    expect(within(field(properties[2]!)).queryByRole('textbox')).toBeNull();
    await show('second', 'another-viewer');
    await settle();
    expect(within(field(properties[1]!)).queryByRole('textbox')).toBeNull();

    // Creation keeps its private holder independently of metadata and the created reader.
    const creation = albumFixture();
    creation.release.types['schema:MusicAlbum']!.labels.en = 'Original Album authority';
    creation.release.properties['schema:inLanguage']!.labels.en = 'Original language authority';
    creation.release.properties['schema:contributor']!.labels.en = 'Private contributor field';
    const admitted: AlbumRead = { ok: true, release: creation.release, public: null };
    let metadata: AlbumRead | Error = admitted;
    const submitted: AlbumCommand[] = [];
    let finishFirstCreate!: (result: Awaited<ReturnType<typeof creation.transport.create>>) => void;
    let finishReader!: (reader: { state: 'ready'; href: string }) => void;
    let finishCreate!: (result: { ok: true; id: string; reader: { state: 'ready'; href: string } }) => void;
    let workspaceLive = true;
    let workspaceAdmission = { reader: 'viewer', live: () => workspaceLive };
    let holderCommits = 0;
    const transport = {
      load: async () => {
        if (metadata instanceof Error) throw metadata;
        return metadata;
      },
      create: async (command: AlbumCommand) => {
        submitted.push(command);
        if (submitted.length === 1)
          return new Promise<Awaited<ReturnType<typeof creation.transport.create>>>((resolve) => {
            finishFirstCreate = resolve;
          });
        if (submitted.length === 2) {
          Object.assign(command, { credential: 'original-native-credential' });
          return { ok: false as const, reason: 'unavailable' as const };
        }
        if (submitted.length === 4)
          return new Promise<{ ok: true; id: string; reader: { state: 'ready'; href: string } }>((resolve) => {
            finishCreate = resolve;
          });
        return { ok: true as const, id: albumId, reader: { state: 'unavailable' as const } };
      },
      read: async () =>
        new Promise<{ state: 'ready'; href: string }>((resolve) => {
          finishReader = resolve;
        }),
    };
    const showCreation = (csrfToken = 'creation') =>
      act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <CandidateReaderBoundary
              observed={{ state: 'signed-in', subject: 'viewer', csrfToken }}
              address="album-create"
              admission={workspaceAdmission}
            >
              <Profiler id="album-private-holder" onRender={() => holderCommits++}>
                <AlbumProfile
                  locale="en"
                  session="signed-in"
                  transport={transport}
                  search={async () => [
                    {
                      id: artistId,
                      title: 'Private artist',
                      types: [creation.publicRead.related[artistId]!.type!],
                      typeLabel: '',
                      cover: null,
                    },
                  ]}
                />
              </Profiler>
            </CandidateReaderBoundary>
          </QueryClientProvider>,
        ),
      );
    await showCreation();
    await settle();
    const form = host.querySelector('form')!;
    const text = (name: string, scope = host) => within(scope).getByRole('textbox', { name }) as HTMLInputElement;
    const type = (control: HTMLElement, value: string) => act(async () => user.type(control, value));
    await type(text(m.catalogue_create_label()), 'Private Album');
    await type(text(m.catalogue_create_description()), 'Private description');
    await type(text(m.catalogue_create_aliases()), 'Private alias');
    await click(m.catalogue_create_add_language());
    const secondTerms = host.querySelectorAll<HTMLElement>('#album-terms fieldset')[1]!;
    await type(text(m.catalogue_create_language(), secondTerms), 'fr');
    await type(text(m.catalogue_create_label(), secondTerms), 'Album privé');
    const termEdit = retainedChange(text(m.catalogue_create_label(), secondTerms));
    await click(m.catalogue_create_add_language());
    const removedTerms = host.querySelectorAll<HTMLElement>('#album-terms fieldset')[2]!;
    const removedTermEdit = retainedChange(text(m.catalogue_create_label(), removedTerms));
    await click(m.catalogue_create_remove_language(), removedTerms);
    expect(host.querySelectorAll('#album-terms fieldset')).toHaveLength(2);
    const beforeRemovedEdit = holderCommits;
    await act(async () => removedTermEdit({ target: { value: 'Removed row edit' } }));
    expect(holderCommits).toBe(beforeRemovedEdit);
    const addFact = async (id: string) => {
      await act(async () =>
        user.selectOptions(within(host).getByRole('combobox', { name: m.character_add_fact() }), id),
      );
      await click(m.correction_add());
      return [...host.querySelectorAll<HTMLElement>('fieldset[id^="album-row-"]')].at(-1)!;
    };
    const scalar = await addFact('schema:inLanguage');
    await type(text(m.correction_value(), scalar), 'fr');
    await type(text(m.relation_citation(), scalar), 'https://private.test/citation');
    const contributor = await addFact('schema:contributor');
    await type(within(contributor).getByRole('combobox', { name: 'Private contributor field' }), 'Private');
    await settle();
    await act(async () =>
      user.click(
        within(window.document.body as unknown as HTMLElement).getByRole('option', { name: /Private artist/ }),
      ),
    );
    metadata = new Error('metadata offline');
    await click(m.album_create());
    const originalCommand = submitted[0]!;
    const exactFirstCommand = structuredClone(originalCommand);
    await act(async () => termEdit({ target: { value: 'Late pending edit' } }));
    expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album privé');
    expect(submitted[0]).toBe(originalCommand);
    expect(submitted[0]).toEqual(exactFirstCommand);
    await settle(() => finishFirstCreate({ ok: false, reason: 'invalid', refreshDefinitions: true }));
    const retiredCreation = () => {
      expect(host.querySelector('form')).toBe(form);
      expect(host.textContent).not.toContain('Original Album authority');
      expect(host.textContent).not.toContain('Original language authority');
      expect(host.querySelector('a[href*="/catalogue/definitions"]')).toBeNull();
      expect(host.textContent).toContain(artistId);
      expect(host.textContent).toContain('https://private.test/citation');
      expect(text(m.catalogue_create_label()).value).toBe('Private Album');
      expect(text(m.catalogue_create_description()).value).toBe('Private description');
      expect(text(m.catalogue_create_aliases()).value).toBe('Private alias');
      expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album privé');
    };
    retiredCreation();
    const beforeUnavailableEdit = holderCommits;
    await act(async () => termEdit({ target: { value: 'Metadata unavailable edit' } }));
    expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album privé');
    expect(holderCommits).toBe(beforeUnavailableEdit);
    const feedback = host.querySelector('[role="alert"], [role="status"]');
    expect(feedback).not.toBeNull();
    const feedbackText = feedback!.textContent;
    await act(async () => {
      termEdit({ target: { value: 'Metadata unavailable edit' } });
      removedTermEdit({ target: { value: 'Removed row edit' } });
    });
    expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album privé');
    expect(host.querySelector('[role="alert"], [role="status"]')?.textContent).toBe(feedbackText);
    await click(m.catalogue_create_review_new());
    expect((within(host).getByRole('button', { name: m.album_create() }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => termEdit({ target: { value: 'Still unavailable edit' } }));
    expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album privé');
    for (const refusal of [
      { ok: false, reason: 'denied' },
      { ...admitted, release: { ...creation.release, types: {} } },
    ] as AlbumRead[]) {
      metadata = refusal;
      await click(m.correction_reload());
      await settle();
      retiredCreation();
      expect(submitted).toHaveLength(1);
    }
    const fresh = structuredClone(creation.release);
    fresh.types['schema:MusicAlbum']!.labels.en = 'Fresh Album authority';
    fresh.types['schema:MusicAlbum']!.properties = fresh.types['schema:MusicAlbum']!.properties.filter(
      (id) => id !== 'schema:inLanguage',
    );
    delete fresh.properties['schema:inLanguage'];
    metadata = { ok: true, release: fresh, public: null };
    await click(m.correction_reload());
    await settle();
    expect(host.textContent).toContain('Fresh Album authority');
    expect(host.textContent).toContain('https://private.test/citation');
    await type(text(m.catalogue_create_label(), secondTerms), 'Album français');
    expect(text(m.catalogue_create_label()).value).toBe('Private Album');
    await click(m.album_create()); // Fresh validation rejects the retained retired fact.
    expect(submitted).toHaveLength(1);
    await click(m.recipe_remove_field(), host.querySelector<HTMLElement>(`#${scalar.id}`)!);
    await click(m.album_create());
    expect(submitted).toHaveLength(2);
    const exact = structuredClone(submitted[1]);
    metadata = new Error('metadata offline again');
    await click(m.correction_reload());
    await settle();
    await click(m.catalogue_create_retry());
    expect(submitted).toHaveLength(3);
    expect(submitted[2]).toBe(submitted[1]);
    expect(submitted[2]).toEqual(exact);
    await act(async () => termEdit({ target: { value: 'Late uncertain edit' } }));
    expect(text(m.catalogue_create_label(), secondTerms).value).toBe('Album français');
    expect(submitted[1]).toBe(submitted[2]);
    expect(submitted[2]).toEqual(exact);
    await click(m.catalogue_create_retry());
    await settle(() => finishReader({ state: 'ready', href: '/en/exact-returned-reader?session=kept' }));
    expect(within(host).getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
      '/en/exact-returned-reader?session=kept',
    );
    expect(submitted).toHaveLength(3);
    metadata = admitted;
    await showCreation('new-csrf-session');
    await settle();
    expect(text(m.catalogue_create_label()).value).toBe('');
    await act(async () => termEdit({ target: { value: 'Retired workspace edit' } }));
    expect(text(m.catalogue_create_label()).value).toBe('');
    expect(host.textContent).not.toContain(artistId);
    const currentWorkspaceEdit = retainedChange(text(m.catalogue_create_label()));
    workspaceLive = false;
    await act(async () => currentWorkspaceEdit({ target: { value: 'Retired live holder edit' } }));
    expect(text(m.catalogue_create_label()).value).toBe('');
    workspaceAdmission = { reader: 'viewer', live: () => true };
    await showCreation('third-csrf-session');
    await settle();
    expect(text(m.catalogue_create_label()).value).toBe('');
    await type(text(m.catalogue_create_label()), 'Retired private Album');
    await click(m.album_create());
    await showCreation('fourth-csrf-session');
    await settle(() =>
      finishCreate({ ok: true, id: albumId, reader: { state: 'ready', href: '/en/late-created-reader' } }),
    );
    expect(text(m.catalogue_create_label()).value).toBe('');
    expect(host.innerHTML).not.toContain('late-created-reader');
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
