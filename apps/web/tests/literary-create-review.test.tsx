import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { LiteraryCommand } from '../src/features/catalogue/literary-profile';
import recorded from '../src/kernel/recorded/definitions-release.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('standalone Literary creation reviews evidence, copies references, and retries unknown delivery without a second subject', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/literary' });
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
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
  const { literaryFixture, literaryWorkId } = await import('../src/kernel/fake/catalogue-literary-profile');
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canvas = () => within(host);
  const release = recorded.release as Release;
  const name = (property: string) => pickText(release.properties[property]?.labels ?? {}, 'en').text;
  const panel = () =>
    [...host.querySelectorAll('legend')].find((element) => element.textContent === m.literary_bibliography())!
      .parentElement as HTMLFieldSetElement;
  const row = (property: string) =>
    [...host.querySelectorAll<HTMLElement>('section[id^="literary-fact-"][aria-label]')].find(
      (section) => section.getAttribute('aria-label') === name(property),
    )!;
  async function render(node: ReactNode, subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10') {
    await act(async () => {
      if (node == null) {
        root.render(null);
        return;
      }
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject, csrfToken: 'token' }}
            address={`literary-create-review:${subject}`}
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      );
    });
  }
  async function choose(type: string) {
    await waitFor(() => expect(canvas().getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined());
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), type),
    );
  }
  async function add(property: string) {
    const select = within(panel()).getByRole('combobox', { name: m.refinement_property() }) as HTMLSelectElement;
    await act(async () => {
      select.value = property;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const addButton = [...panel().querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => button.textContent?.trim() === m.correction_add())
      .at(-1)!;
    expect(addButton).toBeDefined();
    expect(addButton.disabled).toBe(false);
    await act(async () => user.click(addButton));
    return waitFor(() => {
      const added = row(property);
      expect(added).toBeDefined();
      return added;
    });
  }
  function citation(scope: HTMLElement) {
    return within(within(scope).getByRole('group', { name: `${m.correction_references()} 1` })).getByRole('textbox', {
      name: m.correction_url(),
    }) as HTMLInputElement;
  }
  async function fillUrl(scope: HTMLElement, value: string, source: string) {
    const input = within(scope).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    await act(async () => {
      await user.clear(input);
      await user.type(input, value);
      await user.type(citation(scope), source);
    });
  }
  async function confirm() {
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-literary-create-review]')).not.toBeNull();
    expect(host.textContent).toContain(m.literary_review_grain());
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
  }
  const profile = (fixture: ReturnType<typeof literaryFixture>) => (
    <LiteraryProfile
      locale="en"
      session="signed-in"
      transport={fixture.transport}
      facts={fixture.facts}
      review={fixture.review}
    />
  );
  try {
    const fixture = literaryFixture();
    await render(profile(fixture));
    await choose('schema:Book');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed book'),
    );
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_aliases() }), 'Volume'));
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_add_language() })));
    await act(async () => user.type(host.querySelector<HTMLInputElement>('#create-language-1')!, 'ja'));
    await act(async () => user.type(host.querySelector<HTMLInputElement>('#create-label-1')!, '書籍'));
    const urlRow = await add('schema:url');
    const languageRow = await add('schema:inLanguage');
    await fillUrl(urlRow, 'https://example.org/book', 'https://example.org/book-source');
    await act(async () => user.type(within(languageRow).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    await act(async () =>
      user.click(
        within(urlRow).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    const reusePanel = host.querySelector('[data-fact-reuse]')!;
    expect(reusePanel.textContent).toContain('https://example.org/book-source');
    await act(async () => user.click(within(reusePanel).getByRole('checkbox', { name: name('schema:inLanguage') })));
    await act(async () => user.click(within(reusePanel).getByRole('button', { name: m.facts_reuse_apply() })));
    expect(within(languageRow).getAllByRole('group', { name: /Citations/ })).toHaveLength(2);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    const reviewed = host.querySelector('[data-literary-create-review]')!;
    expect(reviewed.textContent).toContain('schema:Book');
    expect(reviewed.textContent).toContain('Reviewed book');
    expect(reviewed.textContent).toContain('書籍');
    expect(reviewed.textContent).toContain('Volume');
    expect(reviewed.textContent).toContain('https://example.org/book-source');
    expect(reviewed.textContent).toContain(m.candidate_rank_normal());
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(host.textContent).toContain(literaryWorkId);
    const book = fixture.calls.find((call) => call.method === 'POST')!.body as LiteraryCommand['item'];
    expect(book.type).toBe('schema:Book');
    expect(book.statements['schema:inLanguage']![0]!.references).toHaveLength(1);
    expect(book.statements['schema:url']![0]!.rank).toBe('normal');
    expect(book.statements['schema:inLanguage']![0]!.references[0]).toEqual(
      book.statements['schema:url']![0]!.references[0],
    );

    const switched = literaryFixture();
    await render(null);
    await render(profile(switched));
    await choose('schema:Book');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept book'));
    await fillUrl(await add('schema:url'), 'https://example.org/book-draft', 'https://example.org/book-cite');
    await choose('schema:BookSeries');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept series'),
    );
    await fillUrl(await add('schema:url'), 'https://example.org/series-draft', 'https://example.org/series-cite');
    await confirm();
    await waitFor(() => expect(switched.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const series = switched.calls.find((call) => call.method === 'POST')!.body as LiteraryCommand['item'];
    expect(series.type).toBe('schema:BookSeries');
    expect(JSON.stringify(series)).toContain('https://example.org/series-draft');
    expect(JSON.stringify(series)).not.toContain('https://example.org/book-draft');

    const repaired = literaryFixture();
    const commands: LiteraryCommand[] = [];
    await render(null);
    await render(
      <LiteraryProfile
        locale="en"
        session="signed-in"
        facts={repaired.facts}
        review={repaired.review}
        transport={{
          ...repaired.transport,
          submit: async (command) => {
            commands.push(structuredClone(command as LiteraryCommand));
            if (commands.length === 1)
              return {
                ok: false as const,
                reason: 'invalid' as const,
                errors: [
                  { pointer: '/statements/schema:url/0/references/0/parts/0/value/content', code: 'invalid_format' },
                ],
              };
            return repaired.transport.submit(command);
          },
        }}
      />,
    );
    await choose('schema:Book');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Repair nested'),
    );
    const repairUrl = await add('schema:url');
    const repairLanguage = await add('schema:inLanguage');
    await fillUrl(repairUrl, 'https://example.org/url', 'https://example.org/bad');
    await act(async () => user.type(within(repairLanguage).getByRole('textbox', { name: m.correction_value() }), 'en'));
    const languageCitation = citation(repairLanguage).id;
    await confirm();
    const link = await waitFor(() => canvas().getByRole('link', { name: new RegExp(name('schema:url')) }));
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).toBe(citation(repairUrl).id);
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).not.toBe(languageCitation);
    await act(async () => user.click(within(repairUrl).getByRole('button', { name: m.literary_remove_fact() })));
    await act(async () => user.click(within(repairUrl).getByRole('button', { name: m.literary_remove_fact() })));
    expect(host.ownerDocument.getElementById(repairUrl.id)).toBeNull();
    expect(citation(repairLanguage).id).toBe(languageCitation);
    await confirm();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]!.item.statements).not.toHaveProperty('schema:url');
    expect(commands[1]!.key).not.toBe(commands[0]!.key);

    const staleReuse = literaryFixture();
    await render(null);
    await render(profile(staleReuse));
    await choose('schema:Book');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Stale copy'));
    const source = await add('schema:url');
    const destination = await add('schema:inLanguage');
    await fillUrl(source, 'https://example.org/source', 'https://example.org/cite-one');
    await act(async () => user.type(within(destination).getByRole('textbox', { name: m.correction_value() }), 'en'));
    await act(async () =>
      user.click(
        within(source).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    await act(async () =>
      user.click(
        within(host.querySelector('[data-fact-reuse]')!).getByRole('checkbox', { name: name('schema:inLanguage') }),
      ),
    );
    await act(async () => {
      await user.clear(citation(source));
      await user.type(citation(source), 'https://example.org/cite-two');
    });
    expect(host.querySelector('[data-fact-reuse]')!.textContent).toContain(m.facts_reuse_stale());
    await act(async () =>
      user.click(within(host.querySelector('[data-fact-reuse]')!).getByRole('button', { name: m.candidate_cancel() })),
    );
    expect(within(destination).getAllByRole('group', { name: /Citations/ })).toHaveLength(1);
    expect(host.querySelector('[data-fact-reuse]')).toBeNull();

    const lost = literaryFixture('uncertain');
    await render(null);
    await render(profile(lost));
    await choose('schema:Book');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Uncertain book'),
    );
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
    const first = lost.calls.filter((call) => call.method === 'POST');
    expect(first).toHaveLength(1);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    const posts = lost.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(posts[1]?.body).toEqual(posts[0]?.body);

    const unread = literaryFixture('reader-unavailable');
    let reads = 0;
    await render(null);
    await render(
      <LiteraryProfile
        locale="en"
        session="signed-in"
        facts={unread.facts}
        review={unread.review}
        transport={{
          ...unread.transport,
          read: async (id) => {
            reads++;
            return unread.transport.read(id);
          },
        }}
      />,
    );
    await choose('schema:Book');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Unread book'),
    );
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
    expect(unread.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(host.textContent).toContain(literaryWorkId);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('button', { name: m.catalogue_create_retry() })).toBeDefined());
    expect(unread.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(
      unread.calls.filter((call) => call.method === 'GET' && call.path === `/v1/subjects/${literaryWorkId}`),
    ).toHaveLength(2);
    expect(reads).toBe(1);

    await render(profile(unread), 'replacement-reader');
    expect(host.textContent).not.toContain(m.catalogue_create_created());
    expect(host.textContent).not.toContain(literaryWorkId);
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
}, 45_000);
