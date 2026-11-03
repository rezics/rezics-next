import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PeopleCommand } from '../src/features/catalogue/people-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('People creation reviews grouped evidence, copies references, and keeps type drafts sealed apart', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/people' });
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
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { peopleProfileFixture, peopleCreatedId } = await import('../src/kernel/fake/catalogue-people-profile');
  const { definitionText } = await import('../src/features/catalogue/definition-guide');
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
  const row = (property: string, region = host) =>
    region.querySelector<HTMLFieldSetElement>(`fieldset[id="people-fact-${property}"]`)!;
  const addName = (fixture: ReturnType<typeof peopleProfileFixture>, property: string) =>
    m.people_profile_add_fact({ field: definitionText(fixture.release.properties[property]?.labels, 'en').text });
  async function render(node: ReactNode) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'token' }}
            address="people-create-evidence"
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  }
  async function choose(type: string) {
    await waitFor(() => expect(canvas().getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined());
    await act(async () => user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), type));
  }
  async function add(fixture: ReturnType<typeof peopleProfileFixture>, property: string) {
    await act(async () => user.click(canvas().getByRole('button', { name: addName(fixture, property) })));
    return row(property);
  }
  function citation(property: string) {
    return within(within(row(property)).getByRole('group', { name: `${m.correction_references()} 1` })).getByRole(
      'textbox',
      { name: m.correction_url() },
    ) as HTMLInputElement;
  }
  async function fillUrl(property: string, value: string, source: string) {
    const input = within(row(property)).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    await act(async () => {
      await user.clear(input);
      await user.type(input, value);
      await user.type(citation(property), source);
    });
  }
  async function confirm() {
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-people-create-review]')).not.toBeNull();
    expect(host.textContent).toContain(m.people_profile_review_credit());
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
  }
  try {
    const fixture = peopleProfileFixture();
    await render(
      <PeopleProfileEditor
        locale="en"
        session="signed-in"
        transport={fixture.transport}
        propose={fixture.propose}
        review={fixture.review}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Person');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed person'));
    await add(fixture, 'schema:url');
    await add(fixture, 'schema:sameAs');
    await fillUrl('schema:url', 'https://example.org/person', 'https://example.org/person-source');
    await fillUrl('schema:sameAs', 'https://example.org/also', 'https://example.org/also-source');
    await act(async () =>
      user.click(
        within(row('schema:url')).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    const panel = host.querySelector('[data-fact-reuse]')!;
    expect(panel.textContent).toContain('https://example.org/person-source');
    await act(async () =>
      user.click(
        within(panel).getByRole('checkbox', {
          name: definitionText(fixture.release.properties['schema:sameAs']?.labels, 'en').text,
        }),
      ),
    );
    await act(async () => user.click(within(panel).getByRole('button', { name: m.facts_reuse_apply() })));
    expect(within(row('schema:sameAs')).getAllByRole('group', { name: /Citations/ })).toHaveLength(2);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(host.querySelector('[data-people-create-review]')?.textContent).toContain(
      'https://example.org/person-source',
    );
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    const personItem = fixture.calls.find((call) => call.method === 'POST')!.body as PeopleCommand['item'];
    expect(personItem.type).toBe('schema:Person');
    expect(personItem.statements!['schema:sameAs']![0]!.references).toHaveLength(2);
    expect(personItem.statements!['schema:sameAs']![0]!.rank).toBe('normal');
    expect(personItem.statements!['schema:sameAs']![0]!.references[1]).toEqual(
      personItem.statements!['schema:url']![0]!.references[0],
    );

    const switched = peopleProfileFixture();
    await render(
      <PeopleProfileEditor
        locale="en"
        session="signed-in"
        transport={switched.transport}
        propose={switched.propose}
        review={switched.review}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Person');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept person'));
    await add(switched, 'schema:url');
    await fillUrl('schema:url', 'https://example.org/person-draft', 'https://example.org/person-cite');
    await choose('schema:Organization');
    await add(switched, 'schema:url');
    await fillUrl('schema:url', 'https://example.org/org-draft', 'https://example.org/org-cite');
    await confirm();
    await waitFor(() => expect(switched.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const organization = switched.calls.find((call) => call.method === 'POST')!.body as PeopleCommand['item'];
    expect(organization.type).toBe('schema:Organization');
    expect(organization.statements!['schema:url']![0]!.value).toEqual({
      type: 'value',
      content: 'https://example.org/org-draft',
    });
    expect(JSON.stringify(organization)).not.toContain('https://example.org/person-draft');

    const repaired = peopleProfileFixture();
    const commands: PeopleCommand[] = [];
    const transport = {
      ...repaired.transport,
      create: async (command: PeopleCommand) => {
        commands.push(structuredClone(command));
        if (commands.length === 1)
          return {
            ok: false as const,
            reason: 'invalid' as const,
            errors: [{ pointer: '/statements/schema:url/0/references/0/parts/0/value/content', code: 'invalid_format' }],
          };
        return repaired.transport.create(command);
      },
    };
    await render(
      <PeopleProfileEditor
        locale="en"
        session="signed-in"
        transport={transport}
        propose={repaired.propose}
        review={repaired.review}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Person');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Repair nested'));
    await add(repaired, 'schema:url');
    await add(repaired, 'schema:sameAs');
    await fillUrl('schema:url', 'https://example.org/url', 'https://example.org/bad');
    await fillUrl('schema:sameAs', 'https://example.org/same', 'https://example.org/same-source');
    const sameId = citation('schema:sameAs').id;
    await confirm();
    const link = await waitFor(() =>
      canvas().getByRole('link', { name: new RegExp(definitionText(repaired.release.properties['schema:url']?.labels, 'en').text) }),
    );
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).toBe(citation('schema:url').id);
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).not.toBe(sameId);
    await act(async () => user.click(within(row('schema:url')).getByRole('button', { name: m.people_profile_remove_fact() })));
    await act(async () => user.click(within(row('schema:url')).getByRole('button', { name: m.people_profile_remove_fact() })));
    expect(row('schema:url')).toBeNull();
    expect(citation('schema:sameAs').id).toBe(sameId);
    await confirm();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]!.item.statements).not.toHaveProperty('schema:url');
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(canvas().getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toContain(
      peopleCreatedId,
    );
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
