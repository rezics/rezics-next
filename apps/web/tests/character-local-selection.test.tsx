import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { CharacterCommand } from '../src/features/catalogue/character-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import type { RelationProposal, RelationResult } from '../src/subject/relation-candidates';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const pickers = new Map<string, (items: { id: string }[]) => void>();
mock.module('@rezics/ui/entity-picker', () => ({
  EntityPicker: (props: { label: string; onValueChange: (items: { id: string }[]) => void }) => {
    pickers.set(props.label, props.onValueChange);
    return <span>{props.label}</span>;
  },
}));

test('Character local choices preserve exact recovery on Stay and fence abandoned holders and picker callbacks', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/character' });
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const fixture = characterProfileFixture();
  const loads: { id?: string; work?: string }[] = [],
    creates: CharacterCommand[] = [],
    proposals: RelationProposal[] = [];
  type ProfileRead = Awaited<ReturnType<typeof fixture.transport.load>>;
  let deferNextLoad = false,
    finishLoad: (value: ProfileRead) => void = () => {};
  let finishCreate: (value: CreateResult) => void = () => {};
  let finishRelation: (value: RelationResult) => void = () => {};
  let deferCreate = false,
    deferRelation = false;
  const transport = {
    ...fixture.transport,
    load: async (address: { id?: string; work?: string }) => {
      loads.push(address);
      if (deferNextLoad) {
        deferNextLoad = false;
        return new Promise<ProfileRead>((resolve) => {
          finishLoad = resolve;
        });
      }
      return fixture.transport.load(address);
    },
    create: (command: CharacterCommand): Promise<CreateResult> => {
      creates.push(command);
      return deferCreate
        ? new Promise((resolve) => {
            finishCreate = resolve;
          })
        : Promise.resolve({ ok: false, reason: 'unavailable' });
    },
  };
  const relation = fixture.props.relations(fixture.work.id);
  const relations = () => ({
    ...relation,
    propose: (command: RelationProposal): Promise<RelationResult> => {
      proposals.push(command);
      return deferRelation
        ? new Promise((resolve) => {
            finishRelation = resolve;
          })
        : Promise.resolve({ ok: false, reason: 'unavailable' });
    },
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const canvas = within(host),
    screen = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  const click = (name: string, scope = canvas) => act(async () => user.click(scope.getByRole('button', { name })));
  const choose = (label: string, id: string) => act(async () => pickers.get(label)!([{ id }]));
  const dialog = () => screen.queryByRole('alertdialog');
  const show = (key: string, id?: string, work?: string) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            key={key}
            address={key}
            observed={{ state: 'signed-in', subject: 'reader', csrfToken: 'current-csrf' }}
          >
            <CharacterProfile
              {...fixture.props}
              locale="en"
              id={id}
              work={work}
              transport={transport}
              relations={relations}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  try {
    await show('creation');
    const label = await waitFor(
      () => canvas.getByRole('textbox', { name: m.catalogue_create_label() }) as HTMLInputElement,
    );
    const oldPicker = pickers.get(m.character_choose_existing())!;
    await act(async () => user.type(label, 'Private traveler'));
    await click(m.character_create());
    await waitFor(() => expect(creates).toHaveLength(1));
    await choose(m.character_choose_existing(), characterProfileId);
    await waitFor(() => expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending()));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await choose(m.character_choose_existing(), 'second-result');
    await click(m.thread_authoring_stay(), screen);
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBe(label);
    expect(label.value).toBe('Private traveler');
    expect(creates).toHaveLength(1);
    deferCreate = true;
    await click(m.correction_retry());
    expect(creates[1]).toBe(creates[0]);
    await choose(m.character_choose_existing(), characterProfileId);
    await choose(m.character_choose_existing(), 'second-result');
    await click(m.thread_authoring_leave(), screen);
    await waitFor(() => expect(loads.at(-1)?.id).toBe(characterProfileId));
    const loadCount = loads.length;
    await act(async () => {
      oldPicker([{ id: 'retired-choice' }]);
      finishCreate({ ok: true, id: 'late-created', reader: { state: 'unavailable' } });
    });
    expect(loads).toHaveLength(loadCount);
    expect(host.querySelector('[data-slot="character-created"]')).toBeNull();
    expect(loads.some((address) => address.id === 'second-result' || address.id === 'retired-choice')).toBe(false);

    await show('credits', characterProfileId, fixture.work.id);
    await waitFor(() => expect(canvas.getByRole('button', { name: m.relation_open() })).toBeDefined());
    await click(m.relation_open());
    await waitFor(() => expect(canvas.getByRole('combobox', { name: m.relation_property() })).toBeDefined());
    await act(async () =>
      user.selectOptions(canvas.getByRole('combobox', { name: m.relation_property() }), 'schema:character'),
    );
    await choose(m.relation_target(), characterProfileId);
    const citation = canvas.getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
    await act(async () => user.type(citation, 'https://example.test/credit'));
    await click(m.relation_propose());
    const confirmation = within(
      canvas.getByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) }),
    );
    await click(m.relation_propose(), confirmation);
    await waitFor(() => expect(proposals).toHaveLength(1));
    await click(m.fictional_work_choose_another());
    await waitFor(() => expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending()));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await click(m.thread_authoring_stay(), screen);
    expect(canvas.getByRole('textbox', { name: m.relation_citation() })).toBe(citation);
    expect(citation.value).toBe('https://example.test/credit');
    expect(host.querySelector('[data-slot="fictional-work-reference"] code')?.textContent).toBe(fixture.work.id);
    deferRelation = true;
    await click(m.relation_propose(), confirmation);
    expect(proposals[1]).toBe(proposals[0]);
    await click(m.fictional_work_choose_another());
    await click(m.thread_authoring_leave(), screen);
    await waitFor(() => expect(loads.at(-1)?.work).toBeUndefined());
    await act(async () => finishRelation({ ok: true, candidate: 'late-candidate', revision: 2 }));
    expect(canvas.queryByText(m.relation_proposed())).toBeNull();
    expect(proposals).toHaveLength(2);
    await waitFor(() => expect(canvas.getByText(m.character_choose_work())).toBeDefined());
    const oldWorkPicker = pickers.get(m.character_choose_work())!;
    await choose(m.character_choose_work(), fixture.work.id);
    await waitFor(() => expect(host.querySelector('[data-slot="fictional-work-reference"]')).not.toBeNull());
    expect(dialog()).toBeNull();
    await act(async () => oldWorkPicker([{ id: 'retired-work' }]));
    expect(loads.at(-1)?.work).toBe(fixture.work.id);

    const reload = canvas.getByRole('button', { name: m.correction_reload() });
    const pointerTarget = window.document.createElement('button');
    host.append(pointerTarget);
    let loadCount = loads.length;
    deferNextLoad = true;
    await act(async () => {
      reload.focus();
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(loads).toHaveLength(loadCount + 1));
    loadCount += 1;
    expect(reload.getAttribute('aria-busy')).toBe('true');
    expect(canvas.getByRole('status').textContent).toBe(m.candidate_loading());
    await act(async () => user.keyboard('{Enter}'));
    expect(loads).toHaveLength(loadCount);
    await act(async () => finishLoad({ ok: false, reason: 'unavailable' }));
    await waitFor(() => expect(reload.getAttribute('aria-busy')).toBe('false'));
    expect(window.document.activeElement).toBe(reload);

    deferNextLoad = true;
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(loads).toHaveLength(loadCount + 1));
    loadCount += 1;
    expect(reload.getAttribute('aria-busy')).toBe('true');
    expect(canvas.getByRole('status').textContent).toBe(m.candidate_loading());
    await act(async () => user.keyboard('{Enter}'));
    expect(loads).toHaveLength(loadCount);
    await act(async () => finishLoad(await fixture.transport.load(loads.at(-1)!)));
    await waitFor(() => expect(reload.getAttribute('aria-busy')).toBe('false'));
    expect(window.document.activeElement).toBe(reload);

    deferNextLoad = true;
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(loads).toHaveLength(loadCount + 1));
    loadCount += 1;
    await act(async () => user.click(pointerTarget));
    await act(async () => finishLoad(await fixture.transport.load(loads.at(-1)!)));
    await waitFor(() => expect(reload.getAttribute('aria-busy')).toBe('false'));
    expect(window.document.activeElement).toBe(pointerTarget);

    deferNextLoad = true;
    await act(async () => {
      reload.focus();
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(loads).toHaveLength(loadCount + 1));
    loadCount += 1;
    const retiredAddress = loads.at(-1)!;
    await show('retired-during-reload', characterProfileId, fixture.work.id);
    await waitFor(() => expect(loads).toHaveLength(loadCount + 1));
    pointerTarget.focus();
    await act(async () => finishLoad(await fixture.transport.load(retiredAddress)));
    expect(window.document.activeElement).toBe(pointerTarget);
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
