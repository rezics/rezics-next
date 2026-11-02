import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
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
    const admitted: AlbumRead = { ok: true, release: creation.release, public: null };
    let metadata: AlbumRead | Error = admitted;
    const submitted: AlbumCommand[] = [];
    let finishReader!: (reader: { state: 'ready'; href: string }) => void;
    let finishCreate!: (result: { ok: true; id: string; reader: { state: 'ready'; href: string } }) => void;
    const transport = {
      load: async () => {
        if (metadata instanceof Error) throw metadata;
        return metadata;
      },
      create: async (command: AlbumCommand) => {
        submitted.push(command);
        if (submitted.length === 1) return { ok: false as const, reason: 'invalid' as const, refreshDefinitions: true };
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
            >
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
    await type(within(contributor).getByRole('combobox'), 'Private');
    await settle();
    await act(async () =>
      user.click(
        within(window.document.body as unknown as HTMLElement).getByRole('option', { name: /Private artist/ }),
      ),
    );
    metadata = new Error('metadata offline');
    await click(m.album_create());
    await settle();
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
    await click(m.catalogue_create_review_new());
    expect((within(host).getByRole('button', { name: m.album_create() }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(host.textContent).not.toContain(artistId);
    await type(text(m.catalogue_create_label()), 'Retired private Album');
    await click(m.album_create());
    await showCreation('third-csrf-session');
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
