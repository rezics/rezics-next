import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import type { CreateResult, CreatedReader, CreateSubjectCommand } from '../src/features/catalogue/create-subject';
import type { FactResult, FactsTransport } from '../src/features/catalogue/subject-facts';
import {
  storyArcType,
  type StoryArcRead,
  type StoryArcTransport,
} from '../src/features/catalogue/story-arc-profile';
import { storyArcCreatedId, storyArcProfileFixture } from '../src/kernel/fake/catalogue-story-arc-profile';

test('same-identity reload retires the old page observation and keeps its private intent', async () => {
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
  const { storyArcProfileFixture, storyArcProfileId } = await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = storyArcProfileFixture('reader-unavailable');
  const client = new QueryClient();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const proposals: Parameters<FactsTransport['propose']>[0][] = [];
  let finishProposal: ((result: FactResult) => void) | undefined;
  let heldRead: Promise<StoryArcRead> | undefined;
  let finishRead: ((read: StoryArcRead) => void) | undefined;
  const facts = (id: string) => ({
    ...fixture.props.facts(id),
    propose: async (command: Parameters<FactsTransport['propose']>[0]) => {
      proposals.push(command);
      if (proposals.length === 1)
        return new Promise<FactResult>((resolve) => {
          finishProposal = resolve;
        });
      return { ok: false as const, reason: 'uncertain' as const };
    },
  });
  const transport = {
    ...fixture.transport,
    load: async (address: { id?: string; work?: string }) => heldRead ?? fixture.transport.load(address),
  };
  const settle = async (action: () => void) => {
    act(action);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const visible = (selector: string) =>
    [...host.querySelectorAll(selector)].filter((node) => !node.closest('[hidden]'));
  const deferRead = () => {
    heldRead = new Promise((resolve) => {
      finishRead = resolve;
    });
  };
  const refreshRead = async () => {
    const read = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
    const finish = finishRead!;
    heldRead = undefined;
    await settle(() => finish(read));
  };

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
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => button(m.relation_open()).click());
    const url = [...host.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === fixture.release.properties['schema:url']!.labels.en,
    )!;
    await settle(() =>
      [...url.querySelectorAll('button')].find((node) => node.textContent === m.facts_edit_field())!.click(),
    );
    const draft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        draft,
        'https://draft.test',
      );
      draft.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = draft.closest('form')!;
    const propsKey = Object.keys(form).find((key) => key.startsWith('__reactProps'))!;
    const oldSubmit = Reflect.get(form, propsKey).onSubmit as (event: { preventDefault(): void }) => void;

    deferRead();
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(draft)).toBe(false);
    expect(visible('a').some((link) => link.getAttribute('href')?.includes(`/subjects/${storyArcProfileId}/`))).toBe(
      false,
    );
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://draft.test');
    await settle(() => oldSubmit({ preventDefault() {} }));
    expect(proposals).toHaveLength(0);
    await refreshRead();

    const restoredDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(restoredDraft.value).toBe('https://draft.test');
    await settle(() =>
      restoredDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(proposals).toHaveLength(1);

    deferRead();
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(restoredDraft)).toBe(false);
    await refreshRead();
    await settle(() =>
      finishProposal!({ ok: true, kind: 'proposed-awaiting-review', candidate: 'retired-result', revision: 1 }),
    );
    expect(host.innerHTML).not.toContain('retired-result');
    const retryDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(retryDraft.value).toBe('https://draft.test');
    await settle(() =>
      retryDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[1]).toBe(proposals[0]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});

type ViewerSession = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

async function mountStoryArcCreate(options: {
  eligibility: () => Promise<CreateAuthority>;
  session?: ViewerSession;
  subject?: string;
  work?: boolean;
  submit?: (command: CreateSubjectCommand) => Promise<CreateResult>;
  read?: (id: string) => Promise<CreatedReader>;
}) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.invalid/en/catalogue/story-arc' });
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
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const viewHref = new URL('../src/features/catalogue/story-arc-profile-view.tsx', import.meta.url).href;
  const { StoryArcProfile } = await import(viewHref);
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const fixture = storyArcProfileFixture();
  const commands: CreateSubjectCommand[] = [];
  const reads: string[] = [];
  const transport: StoryArcTransport = {
    ...fixture.transport,
    creation: {
      ...fixture.transport.creation,
      eligibility: options.eligibility,
      submit: async (command) => {
        commands.push(structuredClone(command));
        return options.submit ? options.submit(command) : fixture.transport.creation.submit(command);
      },
      read: async (id) => {
        reads.push(id);
        return options.read ? options.read(id) : fixture.transport.creation.read(id);
      },
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  let session: ViewerSession = options.session ?? 'signed-in';
  let subject = options.subject ?? 'alice';
  const render = async (next: { session?: ViewerSession; subject?: string } = {}) => {
    if (next.session !== undefined) session = next.session;
    if (next.subject !== undefined) subject = next.subject;
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            CandidateReaderBoundary,
            {
              address: `story-arc-eligibility-${subject || 'guest'}`,
              observed:
                session === 'signed-in'
                  ? { state: 'signed-in' as const, subject, csrfToken: `csrf-${subject}` }
                  : { state: 'signed-out' as const, csrfToken: null },
            },
            createElement(StoryArcProfile, {
              ...fixture.props,
              ...(options.work ? { work: fixture.work.id } : {}),
              locale: 'en',
              session,
              transport,
            }),
          ),
        ),
      ),
    );
  };
  await render();
  const canvas = () => within(host);
  return {
    host,
    canvas,
    user,
    m,
    waitFor,
    act,
    commands,
    reads,
    fixture,
    render,
    submit: async () => {
      const retry = canvas().queryByRole('button', { name: m.catalogue_create_retry() });
      if (retry) return act(async () => user.click(retry));
      await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    },
    async close() {
      await act(async () => root.unmount());
      window.close();
      setLocale(previousLocale, { reload: false });
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('refused, unknown and guest Story Arc eligibility keep admitted work descriptors and block a new create', async () => {
  const guest = await mountStoryArcCreate({
    eligibility: async () => allowedCreateAuthority,
    session: 'signed-out',
    work: true,
  });
  try {
    await guest.waitFor(() => expect(guest.host.textContent).toContain(guest.m.identity_intake_authority_guest()));
    expect(guest.host.textContent).toContain('The actual parent series');
    expect(guest.canvas().getByRole('textbox', { name: guest.m.catalogue_create_label() })).toBeDefined();
    expect(
      (guest.canvas().getByRole('button', { name: guest.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(guest.commands).toHaveLength(0);
  } finally {
    await guest.close();
  }

  let observation: CreateAuthority = { state: 'refused', reason: 'permission' };
  const page = await mountStoryArcCreate({ eligibility: async () => observation, work: true });
  try {
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.host.textContent).toContain('The actual parent series');
    expect(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() })).toBeDefined();
    await page.act(async () =>
      page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Kept draft'),
    );
    expect(
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);

    observation = { state: 'unknown', reason: 'unavailable' };
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(page.m.identity_intake_authority_unknown()),
    );
    expect(
      (page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }) as HTMLInputElement).value,
    ).toBe('Kept draft');
    expect(
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('fresh Story Arc create rechecks eligibility; viewer replacement drops a late allow; uncertain retry keeps the exact command', async () => {
  let observation: CreateAuthority = allowedCreateAuthority;
  let lost = true;
  let createdReads = 0;
  const page = await mountStoryArcCreate({
    eligibility: async () => observation,
    submit: async () => {
      if (lost) {
        lost = false;
        return { ok: false, reason: 'unavailable' };
      }
      return {
        ok: true,
        id: storyArcCreatedId,
        reader: { state: 'unavailable' },
      } satisfies Extract<CreateResult, { ok: true }>;
    },
    read: async (id) => {
      createdReads += 1;
      expect(id).toBe(storyArcCreatedId);
      return {
        state: 'ready',
        href: `/en/subjects/${id}/recovered`,
        identity: { id, type: storyArcType, label: 'Eligible arc' },
      } satisfies CreatedReader;
    },
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.act(async () =>
      page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Eligible arc'),
    );
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.story_arc_create_review_title()));
    observation = { state: 'refused', reason: 'permission' };
    await page.submit();
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.commands).toHaveLength(0);

    observation = allowedCreateAuthority;
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.submit();
    await page.waitFor(() =>
      expect(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() })).toBeDefined(),
    );
    expect(page.commands).toHaveLength(1);
    observation = { state: 'refused', reason: 'permission' };
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(storyArcCreatedId));
    expect(page.commands).toHaveLength(2);
    expect(page.commands[1]!.key).toBe(page.commands[0]!.key);
    expect(page.commands[1]!.item).toEqual(page.commands[0]!.item);
    expect(page.host.textContent).toContain(page.m.catalogue_create_reader_unavailable());
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas().getByRole('link', { name: page.m.catalogue_create_open() }).getAttribute('href')).toBe(
        `/en/subjects/${storyArcCreatedId}/recovered`,
      ),
    );
    expect(page.commands).toHaveLength(2);
    expect(createdReads).toBe(1);
  } finally {
    await page.close();
  }
});

test('viewer replacement drops a late allowed Story Arc observation', async () => {
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  const page = await mountStoryArcCreate({
    eligibility: () => {
      calls += 1;
      if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
      return Promise.resolve({ state: 'refused', reason: 'permission' });
    },
    work: true,
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_reading()));
    expect(page.host.textContent).toContain('The actual parent series');
    expect(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() })).toBeDefined();
    await page.render({ subject: 'bob' });
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    pending?.(allowedCreateAuthority);
    await page.act(async () => undefined);
    expect(page.canvas().getByRole('alert').textContent).toContain(
      page.m.identity_intake_authority_refused_permission(),
    );
    expect(
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});
