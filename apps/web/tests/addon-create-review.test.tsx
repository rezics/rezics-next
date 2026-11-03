import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonRead, AddonTransport } from '../src/features/catalogue/addon-profile';
import type { CreateResult, CreateSubjectCommand } from '../src/features/catalogue/create-subject';
import type { GameItem } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('add-on creator reviews the exact item, repairs nested diagnostics, and retries known readback without a second create', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/addon' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
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
  const { createRoot } = await import('react-dom/client');
  const { AddonProfileCreate } = await import('../src/features/catalogue/addon-profile-create');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { addonBase, addonType } = await import('../src/features/catalogue/addon-profile');
  const { addonProfileFixture, addonWorkId, addonCreatedId } = await import('../src/kernel/fake/catalogue-addon-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document, delay: null });
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let generation = 0;
  const created: Extract<CreateResult, { ok: true }>[] = [];
  async function render(node: ReactNode, fresh = true, retired = false) {
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
            address={`addon-review:${generation}`}
            observed={
              retired
                ? { state: 'signed-out', csrfToken: null }
                : { state: 'signed-in', subject: 'original-reader', csrfToken: 'original-csrf' }
            }
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  }
  const canvas = () => within(host);
  const group = () => host.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
  async function input(element: HTMLElement, value: string) {
    await act(async () => {
      const prototype =
        element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  async function add(property: string) {
    await act(async () => user.selectOptions(within(group()).getByRole('combobox', { name: m.character_add_fact() }), property));
    await act(async () => user.click(within(group()).getAllByRole('button', { name: m.correction_add() })[0]!));
    return [...group().querySelectorAll<HTMLElement>(':scope > fieldset > section')].at(-1)!;
  }
  async function confirm() {
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-addon-create-review]')).not.toBeNull();
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
  }
  function creator(read: Extract<AddonRead, { ok: true }>, transport: AddonTransport) {
    return (
      <AddonProfileCreate
        read={read}
        locale="en"
        session="signed-in"
        transport={transport}
        search={addonProfileFixture().props.search}
        onCreated={(result) => created.push(result)}
      />
    );
  }
  try {
    const fixture = addonProfileFixture();
    const read = await fixture.transport.load({ work: addonWorkId });
    if (!read.ok) throw new Error('Expected add-on read');
    const commands: CreateSubjectCommand[] = [];
    const transport: AddonTransport = {
      ...fixture.transport,
      create: async (command) => {
        commands.push(structuredClone(command));
        if (commands.length === 1)
          return {
            ok: false,
            reason: 'invalid',
            errors: [{ pointer: '/statements/schema:url/0/references/0/parts/0/value/content', code: 'invalid_format' }],
          };
        return fixture.transport.create(command);
      },
    };
    await render(creator(read, transport));
    await waitFor(() => expect(host.querySelector('form')).not.toBeNull());
    await input(host.querySelector('input[id="create-label-0"]')!, 'Reviewed expansion');
    await input(host.querySelector('input[id="create-language-0"]')!, 'en');
    await input(host.querySelector('textarea[id="create-aliases-0"]')!, 'Northern lights alternate');
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_add_language() })));
    await input(host.querySelector('input[id="create-language-1"]')!, 'ja');
    await input(host.querySelector('input[id="create-label-1"]')!, '北の光');
    const urlRow = await add('schema:url');
    const sameRow = await add('schema:sameAs');
    await input(within(urlRow).getAllByRole('textbox', { name: m.correction_url() })[0]!, 'https://example.org/addon');
    await act(async () => user.click(within(urlRow).getByRole('button', { name: m.correction_add_reference() })));
    const urlPart = within(urlRow).getByRole('combobox', { name: m.correction_add_part() });
    await act(async () => user.selectOptions(urlPart, 'schema:url'));
    await act(async () =>
      user.click(within(urlPart.closest('[data-slot="field"]')!.parentElement!).getByRole('button', { name: m.correction_add() })),
    );
    await input(within(urlRow).getAllByRole('textbox', { name: m.correction_url() })[1]!, 'https://example.org/addon-source');
    await input(within(sameRow).getAllByRole('textbox', { name: m.correction_url() })[0]!, 'https://example.org/also');
    await act(async () =>
      user.click(
        within(urlRow).getByRole('button', { name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1` }),
      ),
    );
    const panel = host.querySelector('[data-fact-reuse]')!;
    expect(panel.textContent).toContain(m.addon_create_review_reuse_base());
    expect(panel.textContent).not.toContain(addonWorkId);
    await act(async () => user.click(within(panel).getByRole('checkbox')));
    await act(async () => user.click(within(panel).getByRole('button', { name: m.facts_reuse_apply() })));
    expect(within(sameRow).getAllByRole('group', { name: /Citations/ }).length).toBeGreaterThan(1);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(commands).toHaveLength(0);
    const review = host.querySelector('[data-addon-create-review]')!;
    expect(review.textContent).toContain('Reviewed expansion');
    expect(review.textContent).toContain('北の光');
    expect(review.textContent).toContain('Northern lights alternate');
    expect(review.textContent).toContain(m.addon_create_review_base_omitted());
    expect(review.textContent).toContain(addonWorkId);
    expect(review.textContent).toContain(m.candidate_rank_normal());
    expect(review.textContent).not.toContain(m.candidate_rank_preferred());
    expect(JSON.stringify(commands)).not.toContain(addonWorkId);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    const link = await waitFor(() =>
      canvas().getByRole('link', { name: new RegExp(read.release.properties['schema:url']?.labels?.en ?? 'URL', 'i') }),
    );
    const urlControl = within(urlRow).getAllByRole('textbox', { name: m.correction_url() })[1] as HTMLInputElement;
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).toBe(urlControl.id);
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).not.toBe(group().id);
    const sameId = (within(sameRow).getAllByRole('textbox', { name: m.correction_url() })[0] as HTMLInputElement).id;
    await act(async () => user.click(within(urlRow).getByRole('button', { name: m.recipe_remove_field() })));
    await act(async () => user.click(within(urlRow).getByRole('button', { name: m.recipe_remove_field() })));
    expect(urlRow.isConnected).toBe(false);
    expect(sameId).not.toBe(decodeURIComponent(link.getAttribute('href')!.slice(1)));
    expect(host.querySelector(`#${CSS.escape(decodeURIComponent(link.getAttribute('href')!.slice(1)))}`)).toBeNull();
    await confirm();
    await waitFor(() => expect(commands).toHaveLength(2));
    const item = commands[1]!.item as GameItem;
    expect(item.type).toBe(addonType);
    expect(item.labels).toEqual({ en: 'Reviewed expansion', ja: '北の光' });
    expect(item.aliases.en).toEqual(['Northern lights alternate']);
    expect(item.statements[addonBase]).toBeUndefined();
    expect(item.statements['schema:sameAs']![0]!.rank).toBe('normal');
    expect(item.statements['schema:sameAs']![0]!.references.length).toBeGreaterThanOrEqual(2);
    expect(commands[1]!.key).not.toBe(commands[0]!.key);

    const uncertain = addonProfileFixture('uncertain');
    const uncertainRead = await uncertain.transport.load({});
    if (!uncertainRead.ok) throw new Error('Expected uncertain read');
    const retries: CreateSubjectCommand[] = [];
    await render(
      creator(uncertainRead, {
        ...uncertain.transport,
        create: async (command) => {
          retries.push(structuredClone(command));
          return uncertain.transport.create(command);
        },
      }),
    );
    await input(host.querySelector('input[id="create-label-0"]')!, 'Uncertain expansion');
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(retries).toHaveLength(2);
    expect(retries[1]).toEqual(retries[0]);

    const unread = addonProfileFixture('reader-unavailable');
    const unreadRead = await unread.transport.load({});
    if (!unreadRead.ok) throw new Error('Expected unread read');
    const writes: string[] = [];
    await render(
      creator(unreadRead, {
        ...unread.transport,
        create: async (command) => {
          writes.push('POST');
          return unread.transport.create(command);
        },
        read: async (id) => {
          writes.push(`GET ${id}`);
          return unread.transport.read(id);
        },
      }),
    );
    await input(host.querySelector('input[id="create-label-0"]')!, 'Unread expansion');
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
    const before = writes.length;
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(writes.length).toBeGreaterThan(before));
    expect(writes.filter((entry) => entry === 'POST')).toHaveLength(1);
    expect(writes.at(-1)).toBe(`GET ${addonCreatedId}`);

    const retiring = addonProfileFixture();
    const retiringRead = await retiring.transport.load({});
    if (!retiringRead.ok) throw new Error('Expected retirement read');
    let finish!: (result: CreateResult) => void;
    const pending = new Promise<CreateResult>((resolve) => {
      finish = resolve;
    });
    const beforeCreated = created.length;
    await render(creator(retiringRead, { ...retiring.transport, create: () => pending }));
    await input(host.querySelector('input[id="create-label-0"]')!, 'Retired expansion');
    await confirm();
    await render(null, false, true);
    await act(async () => finish({ ok: true, id: addonCreatedId, reader: { state: 'ready', href: '/en/subjects/retired' } }));
    expect(created).toHaveLength(beforeCreated);
    expect(host.innerHTML).not.toContain(addonCreatedId);
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
