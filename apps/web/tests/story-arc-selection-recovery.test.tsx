import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { RelationTransport, RelationResult } from '../src/subject/relation-candidates';
import { act } from 'react';
import type { FactsTransport, FactResult } from '../src/features/catalogue/subject-facts';
import type { StoryArcRead } from '../src/features/catalogue/story-arc-profile';

test('refused readings retire markup and callbacks, recovery retains sealed drafts, and selection opens the created arc', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/story-arc' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { StoryArcProfile } = await import('../src/features/catalogue/story-arc-profile-view');
  const { storyArcProfileFixture, storyArcProfileId, storyArcCreatedId } =
    await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = storyArcProfileFixture('reader-unavailable');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const relationCommands: Parameters<RelationTransport['propose']>[0][] = [];
  let finishRelation!: (result: RelationResult) => void;
  const relations = (id: string) => ({
    ...fixture.props.relations(id),
    propose: async (command: Parameters<RelationTransport['propose']>[0]): Promise<RelationResult> => {
      relationCommands.push(command);
      if (relationCommands.length === 1) return { ok: false, reason: 'unavailable' };
      return new Promise((resolve) => {
        finishRelation = resolve;
      });
    },
  });
  const client = new QueryClient();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  let failure: false | 'unavailable' | 'denied' = false;
  let recovered = false;
  let lateFact: ((value: FactResult) => void) | undefined;
  const commands: Parameters<FactsTransport['propose']>[0][] = [];
  const facts = (id: string) => ({
    ...fixture.props.facts(id),
    propose: async (command: Parameters<FactsTransport['propose']>[0]) => {
      commands.push(command);
      if (commands.length === 1)
        return new Promise<FactResult>((resolve) => {
          lateFact = resolve;
        });
      return { ok: false as const, reason: 'uncertain' as const };
    },
  });
  let held: Promise<StoryArcRead> | undefined;
  let lateRead: ((read: StoryArcRead) => void) | undefined;
  const loads: { id?: string | undefined; work?: string | undefined }[] = [];
  const transport = {
    ...fixture.transport,
    load: async (address: (typeof loads)[number]) => {
      loads.push(address);
      if (held) return held;
      if (failure === 'unavailable') throw new Error('refresh unavailable');
      if (failure) return { ok: false as const, reason: failure };
      const read = await fixture.transport.load(
        address.id === storyArcCreatedId ? { ...address, id: storyArcProfileId } : address,
      );
      if (read.ok && read.arc && address.id === storyArcCreatedId)
        return {
          ...read,
          arc: {
            ...read.arc,
            subject: { ...read.arc.subject, id: storyArcCreatedId, labels: { en: 'A real arc' }, statements: {} },
          },
        };
      if (recovered && read.ok && read.arc)
        return { ...read, arc: { ...read.arc, subject: { ...read.arc.subject, labels: { en: 'Recovered arc' } } } };
      return read;
    },
  };
  const settle = async (action: () => void) => {
    act(action);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const dialog = () => within(window.document.body as unknown as HTMLElement).getByRole('alertdialog');
  const decide = (label: string) => act(async () => user.click(within(dialog()).getByRole('button', { name: label })));
  const visible = (selector: string) =>
    [...host.querySelectorAll(selector)].filter((node) => !node.closest('[hidden]'));
  try {
    await settle(() =>
      root.render(
        <QueryClientProvider client={client}>
          <StoryArcProfile
            {...fixture.props}
            locale="en"
            id={storyArcProfileId}
            work={fixture.work.id}
            transport={transport}
            facts={facts}
            relations={relations}
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => button(m.relation_open()).click());
    await act(async () =>
      user.selectOptions(within(host).getByRole('combobox', { name: m.relation_property() }), 'rezics:storyArc'),
    );
    await settle(() =>
      [...host.querySelectorAll('button')].find((node) => node.textContent === m.relation_edit_existing())!.click(),
    );
    await settle(() => button(m.relation_propose()).click());
    const confirmRelation = () =>
      [...host.querySelectorAll('button')].filter((node) => node.textContent === m.relation_propose()).at(-1)!;
    await settle(() => confirmRelation().click());
    expect(relationCommands).toHaveLength(1);
    const exactRelation = structuredClone(relationCommands[0]);
    const opener = button(m.fictional_work_choose_another());
    opener.focus();
    await settle(() => opener.click());
    expect(dialog().textContent).toContain(m.thread_authoring_leave_pending());
    const beforeStay = loads.length;
    await settle(() => button(m.story_arc_choose_existing()).click()); // The first destination wins.
    expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await decide(m.thread_authoring_stay());
    expect(loads).toHaveLength(beforeStay);
    expect(window.document.activeElement).toBe(opener);
    await settle(() => confirmRelation().click());
    expect(relationCommands[1]).toBe(relationCommands[0]);
    expect(relationCommands[1]).toEqual(exactRelation);
    const retiredRelationSubmit = Reflect.get(
      confirmRelation(),
      Object.keys(confirmRelation()).find((key) => key.startsWith('__reactProps'))!,
    ).onClick;
    const url = [...host.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === fixture.release.properties['schema:url']!.labels.en,
    )!;
    expect(url).toBeDefined();
    await settle(() =>
      [...url.querySelectorAll('button')].find((node) => node.textContent === m.facts_edit_field())!.click(),
    );
    const valueLabel = [...host.querySelectorAll('label')].find((node) => node.textContent === m.correction_url())!;
    const draft = window.document.getElementById(valueLabel.htmlFor);
    expect(draft).not.toBeNull();
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        draft,
        'https://draft.test',
      );
      draft!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = draft!.closest('form')!;
    const propsKey = Object.keys(form).find((key) => key.startsWith('__reactProps'))!;
    const savedSubmit = Reflect.get(form, propsKey).onSubmit;
    const oldIdentity = [storyArcProfileId, fixture.work.id, 'The journey arc', 'The actual parent series'];
    await settle(() => button(m.story_arc_choose_existing()).click());
    await decide(m.thread_authoring_stay());
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')).toBe(draft);
    failure = 'unavailable';
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(draft!)).toBe(false);
    for (const identity of oldIdentity) expect(host.innerHTML).not.toContain(identity);
    await settle(() => savedSubmit({ preventDefault() {} }));
    expect(commands).toHaveLength(0);
    failure = false;
    await settle(() => button(m.correction_reload()).click());
    const restoredDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(restoredDraft.value).toBe('https://draft.test');
    await settle(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    // The old detached form cannot submit into the restored reading.
    expect(commands).toHaveLength(0);
    await settle(() =>
      restoredDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(commands).toHaveLength(1);
    failure = 'denied';
    await settle(() => button(m.correction_reload()).click());
    for (const identity of oldIdentity) expect(host.innerHTML).not.toContain(identity);
    await settle(() => savedSubmit({ preventDefault() {} }));
    expect(commands).toHaveLength(1);
    failure = false;
    recovered = true;
    await settle(() => button(m.correction_reload()).click());
    expect(host.textContent).toContain('Recovered arc');
    await settle(() =>
      lateFact!({ ok: true, kind: 'proposed-awaiting-review', candidate: 'late-refused-candidate', revision: 1 }),
    );
    expect(host.innerHTML).not.toContain('late-refused-candidate');
    expect(host.innerHTML).not.toContain('The journey arc');
    const retryDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(retryDraft.value).toBe('https://draft.test');
    await settle(() =>
      retryDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    held = new Promise((resolve) => {
      lateRead = resolve;
    });
    await settle(() => button(m.fictional_work_choose_another()).click());
    await decide(m.thread_authoring_leave());
    expect(loads.at(-1)).toEqual({ id: storyArcProfileId, work: undefined });
    await settle(() => {
      retiredRelationSubmit();
      finishRelation({ ok: true, kind: 'proposed', candidate: 'retired-work-result', revision: 1 });
    });
    expect(relationCommands).toHaveLength(2);
    expect(host.innerHTML).not.toContain('retired-work-result');
    expect(visible('[data-slot="fictional-work-reference"]')).toHaveLength(0);
    expect(visible('input').includes(draft!)).toBe(false);
    held = undefined;
    await settle(() => button(m.correction_reload()).click());
    await settle(() => button(m.story_arc_choose_existing()).click());
    expect(loads.at(-1)).toEqual({ id: undefined, work: undefined });
    const label = [...host.querySelectorAll('label')].find((node) => node.textContent === m.catalogue_create_label())!;
    const input = window.document.getElementById(label.htmlFor)!;
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'A real arc');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const picker = within(host).getByRole('combobox', { name: m.story_arc_choose_existing() });
    await act(async () => {
      await user.type(picker, 'journey');
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await act(async () =>
      user.click(
        within(window.document.body as unknown as HTMLElement).getByRole('option', { name: /The journey arc/ }),
      ),
    );
    await decide(m.thread_authoring_stay());
    expect((input as HTMLInputElement).value).toBe('A real arc');
    expect(loads.at(-1)?.id).toBeUndefined();
    await settle(() => button(m.catalogue_create_submit()).click());
    const posts = () => fixture.creation.calls.filter((call) => call.method === 'POST').length;
    expect(posts()).toBe(1);
    fixture.creation.setScenario('ready');
    await settle(() => button(m.catalogue_create_retry()).click());
    const continuation = [...host.querySelectorAll('a')].find((node) => node.textContent === m.story_arc_continue())!;
    expect(continuation.href).toContain(`/subjects/${storyArcCreatedId}/a-real-arc/story-arc`);
    await settle(() => continuation.click());
    expect(loads.at(-1)?.id).toBe(storyArcCreatedId);
    expect(posts()).toBe(1);
    expect(
      visible('a').some((link) =>
        link.getAttribute('href')?.includes(`/subjects/${storyArcCreatedId}/a-real-arc/relation-edit`),
      ),
    ).toBe(true);
    expect(visible('input').includes(input)).toBe(false);
    const previousRead = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
    await settle(() => lateRead!(previousRead));
    expect(host.innerHTML).not.toContain('The journey arc');
    expect(host.textContent).toContain('A real arc');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
