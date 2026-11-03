import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PeopleCommand, PeopleRead, PeopleTransport } from '../src/features/catalogue/people-profile';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN. This mounts the default PeopleProfileEditor and CreateSubjectForm with the
// existing generated-request fixture. DOM construction proves no geometry, SSR or native authority.
// Canonical connected plays separately author browser focus/reflow; all execution is deferred.
test('whole Person and Organization creation families retain exact facts, independent drafts and original-reader recovery', async () => {
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
      throw new Error('Creation presentation must use supplied reads');
    }) as typeof fetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { peopleProfiles } = await import('../src/features/catalogue/people-profile');
  const { definitionText } = await import('../src/features/catalogue/definition-guide');
  const { peopleProfileFixture, peopleCreatedId, peoplePersonId } =
    await import('../src/kernel/fake/catalogue-people-profile');
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
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) event.preventDefault();
  });
  type Session = 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  async function render(
    node: ReactNode,
    session: Session = 'signed-in',
    fresh = true,
    authority: { subject?: string; csrfToken?: string } = {},
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
              csrfToken: session === 'signed-in' ? 'illustrative-token' : null,
              ...authority,
            }}
            address={`people-create-family:${generation}`}
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
  type Fixture = ReturnType<typeof peopleProfileFixture>;
  function editor(fixture: Fixture, transport = fixture.transport, session: Session = 'signed-in', id?: string) {
    return (
      <PeopleProfileEditor
        id={id}
        locale="en"
        session={session}
        transport={transport}
        propose={fixture.propose}
        review={fixture.review}
        onNavigate={(href) => navigations.push(href)}
      />
    );
  }
  const canvas = () => within(host);
  const fields = () => host.querySelectorAll<HTMLFieldSetElement>('fieldset[id^="people-fact-"]');
  const group = (property: string, region = host) =>
    region.querySelector<HTMLFieldSetElement>(`fieldset[id="people-fact-${property}"]`)!;
  const citationInput = (region: HTMLElement) =>
    within(within(region).getByRole('group', { name: `${m.correction_references()} 1` })).getByRole('textbox', {
      name: m.correction_url(),
    }) as HTMLInputElement;
  const name = (fixture: Fixture, property: string) =>
    definitionText(fixture.release.properties[property]?.labels, 'en').text;
  async function choose(type: string, region = host) {
    await waitFor(() =>
      expect(within(region).getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined(),
    );
    await act(async () =>
      user.selectOptions(within(region).getByRole('combobox', { name: m.catalogue_create_type() }), type),
    );
  }
  async function add(fixture: Fixture, property: string, region = host) {
    await act(async () =>
      user.click(
        within(region).getByRole('button', {
          name: m.people_profile_add_fact({ field: name(fixture, property) }),
        }),
      ),
    );
    return group(property, region);
  }
  async function value(fixture: Fixture, property: string, text: string, region = host) {
    const label = fixture.release.properties[property]!.datatype === 'url' ? m.correction_url() : m.correction_value();
    const input = within(group(property, region)).getAllByRole('textbox', { name: label })[0]!;
    await act(async () => {
      await user.clear(input);
      await user.type(input, text);
    });
  }
  async function terms(label: string, region = host) {
    await act(async () => user.type(within(region).getByRole('textbox', { name: m.catalogue_create_label() }), label));
  }
  async function submit(region = host) {
    await act(async () => user.click(within(region).getByRole('button', { name: m.catalogue_create_submit() })));
    if (region.querySelector('[data-people-create-review]'))
      await act(async () => user.click(within(region).getByRole('button', { name: m.catalogue_create_submit() })));
  }
  const url = `https://example.org/${'sourceSansEspaces'.repeat(24)}`;
  const citation = `https://example.org/${'citation/'.repeat(36)}evidence`;
  const scalarValues: Record<string, string> = {
    'schema:url': url,
    'schema:sameAs': 'https://example.org/same-entity',
    'wdt:P3180': 'p123',
    'wdt:P6298': '123',
    'wdt:P648': 'OL23919A',
  };
  try {
    for (const width of [390, 1280])
      for (const direction of ['ltr', 'rtl']) {
        window.happyDOM.setWindowSize({ width, height: 900 });
        host.style.width = `${width}px`;
        host.dir = direction;
        for (const type of ['schema:Person', 'schema:Organization']) {
          const fixture = peopleProfileFixture();
          const profile = peopleProfiles(fixture.release, 'en').find((entry) => entry.id === type)!;
          expect(profile.fields).toEqual(
            type === 'schema:Person'
              ? [
                  'schema:birthDate',
                  'schema:deathDate',
                  'schema:sameAs',
                  'schema:url',
                  'wdt:P3180',
                  'wdt:P6298',
                  'wdt:P648',
                ]
              : ['schema:sameAs', 'schema:url', 'wdt:P3180'],
          );
          expect(profile.unsupported).toEqual(['schema:image']);
          expect(profile.relations).toEqual(['rezics:penNameOf']);
          const longLabel = `URL 人物 조직 ميرا ${'IdentiteSansEspaces'.repeat(14)}`;
          const longDescription = `Full supplied field meaning 人物 조직 ميرا ${'descriptionSansEspaces'.repeat(18)}`;
          fixture.release.properties['schema:url']!.labels.en = longLabel;
          fixture.release.properties['schema:url']!.descriptions = { en: longDescription };
          await render(editor(fixture));
          await choose(type);
          expect(fields()).toHaveLength(0); // Optional means explicit selection, never inferred defaults.
          expect(host.textContent).toContain(profile.description);
          expect(host.textContent).toContain(m.people_profile_unsupported());
          expect(host.textContent).toContain(name(fixture, 'schema:image'));
          expect(
            canvas().queryByRole('button', {
              name: m.people_profile_add_fact({ field: name(fixture, 'schema:image') }),
            }),
          ).toBeNull();
          expect(profile.fields).not.toContain('schema:name');
          expect(fixture.release.properties['schema:sameAs']!.multivalued).toBe(true);
          expect(fixture.release.properties['schema:url']!.multivalued).toBe(false);
          await terms('Family example');
          const initialCalls = fixture.calls.length;
          const expected: Record<string, StatementInput[]> = {};
          for (const property of profile.fields) {
            const fieldset = await add(fixture, property);
            const local = within(fieldset);
            expect(fieldset.tagName).toBe('FIELDSET');
            expect(fieldset.firstElementChild?.tagName).toBe('LEGEND');
            expect(local.getByRole('heading', { level: 3, name: name(fixture, property) }).closest('legend')).toBe(
              fieldset.firstElementChild,
            );
            expect(fieldset.closest('section')?.querySelector('h2')?.textContent).toBe(m.people_profile_initial());
            const frame = fieldset.querySelector<HTMLElement>('[data-slot="people-initial-fact"]')!;
            expect(frame.className).toContain('group relative isolate');
            expect(frame.className).toContain('min-w-0');
            expect(frame.querySelector('[data-slot="people-initial-fact"]') ?? frame).toBe(frame);
            for (const element of [fieldset, frame, fieldset.querySelector('h3')!]) {
              expect(element.className).not.toMatch(/truncate|line-clamp/);
            }
            expect(
              canvas().queryByRole('button', { name: m.people_profile_add_fact({ field: name(fixture, property) }) }),
            ).toBeNull();
            const description = definitionText(fixture.release.properties[property]!.descriptions, 'en');
            expect(frame.textContent).toContain(description.text);
            expect(local.getByRole('heading', { level: 3 }).getAttribute('class')).toContain(
              '[overflow-wrap:anywhere]',
            );
            let content: unknown = scalarValues[property];
            if (fixture.release.properties[property]!.datatype === 'time') {
              const precision = property === 'schema:birthDate' ? 11 : 9;
              await act(async () =>
                user.selectOptions(local.getByRole('combobox', { name: m.correction_precision() }), String(precision)),
              );
              await act(async () => user.type(local.getByRole('textbox', { name: m.correction_year() }), '1980'));
              if (precision === 11) {
                await act(async () => user.type(local.getByRole('spinbutton', { name: m.correction_month() }), '4'));
                await act(async () => user.type(local.getByRole('spinbutton', { name: m.correction_day() }), '3'));
              }
              content = {
                time: precision === 11 ? '+1980-04-03T00:00:00Z' : '+1980-00-00T00:00:00Z',
                precision,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              };
            } else await value(fixture, property, String(content));
            const cite = citationInput(fieldset);
            expect(cite.id).toMatch(/-people-\d+-part-\d+-value$/);
            expect(cite.getAttribute('type')).toBe('url');
            await act(async () => user.type(cite, citation));
            expect(cite.value).toBe(citation);
            expect(cite.className).toContain('min-h-11');
            expect(cite.className).toContain('md:pointer-fine:min-h-8');
            const remove = local.getByRole('button', { name: m.people_profile_remove_fact() });
            expect(remove.getAttribute('type')).toBe('button');
            expect(remove.className).toContain('min-h-11');
            expect(remove.className).toContain('md:pointer-fine:min-h-8');
            expected[property] = [
              {
                property: { id: property },
                value: { type: 'value', content },
                qualifiers: [],
                rank: 'normal',
                references: [
                  { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
                ],
              },
            ];
          }
          expect(fields()).toHaveLength(profile.fields.length);
          expect(group('schema:url').textContent).toContain(longDescription);
          expect(fixture.calls).toHaveLength(initialCalls); // Editing and layout do not hydrate rows.
          await submit();
          await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
          const writes = fixture.calls.filter((call) => call.method === 'POST');
          expect(writes).toHaveLength(1);
          expect(writes[0]!.body).toEqual({
            type,
            labels: { en: 'Family example' },
            descriptions: {},
            aliases: {},
            statements: expected,
          });
          expect(writes[0]!.authorization).toBe('Bearer fixture');
          expect(fixture.calls.at(-1)).toMatchObject({ path: `/v1/subjects/${peopleCreatedId}`, authorization: null });
          expect(fixture.calls.length - initialCalls).toBe(4); // Active release + release + one write + current read.
        }
      }

    const optional = peopleProfileFixture();
    await render(editor(optional));
    await choose('schema:Person');
    await terms('Terms without initial facts');
    await submit();
    await waitFor(() => expect(optional.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(optional.calls.find((call) => call.method === 'POST')!.body).not.toHaveProperty('statements');

    // Two separately supplied default forms keep their own type drafts and original native anchors.
    const left = peopleProfileFixture();
    const right = peopleProfileFixture();
    await render(
      <>
        <div data-example="left">{editor(left)}</div>
        <div data-example="right">{editor(right)}</div>
      </>,
    );
    const a = host.querySelector<HTMLElement>('[data-example="left"]')!;
    const b = host.querySelector<HTMLElement>('[data-example="right"]')!;
    await choose('schema:Person', a);
    await choose('schema:Organization', b);
    await add(left, 'schema:url', a);
    await value(left, 'schema:url', 'https://example.org/person', a);
    await add(right, 'schema:url', b);
    await value(right, 'schema:url', 'https://example.org/organization', b);
    const personInput = within(group('schema:url', a)).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    const organizationInput = within(group('schema:url', b)).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    expect(personInput.id).not.toBe(organizationInput.id); // Shared ScalarControl owns presentation IDs.
    organizationInput.focus();
    expect(window.document.activeElement).toBe(organizationInput);
    await choose('schema:Organization', a);
    expect(group('schema:url', a)).toBeNull();
    await add(left, 'schema:url', a);
    await value(left, 'schema:url', 'https://example.org/other-draft', a);
    await choose('schema:Person', a);
    expect(
      (within(group('schema:url', a)).getAllByRole('textbox', { name: m.correction_url() })[0] as HTMLInputElement)
        .value,
    ).toBe('https://example.org/person');
    expect((organizationInput as HTMLInputElement).value).toBe('https://example.org/organization');
    await act(async () =>
      user.click(within(group('schema:url', a)).getByRole('button', { name: m.people_profile_remove_fact() })),
    );
    await act(async () =>
      user.click(within(group('schema:url', a)).getByRole('button', { name: m.people_profile_remove_fact() })),
    );
    expect(group('schema:url', a)).toBeNull();
    await add(left, 'schema:url', a);
    expect(
      (within(group('schema:url', a)).getAllByRole('textbox', { name: m.correction_url() })[0] as HTMLInputElement)
        .value,
    ).toBe('');
    await value(left, 'schema:url', 'https://example.org/readded', a);
    await terms('Independent person', a);
    await terms('Independent organization', b);
    await submit(a);
    await waitFor(() => expect(within(a).getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(right.calls.some((call) => call.method === 'POST')).toBe(false);
    await submit(b);
    await waitFor(() => expect(within(b).getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(
      (right.calls.find((call) => call.method === 'POST')!.body as PeopleCommand['item']).statements!['schema:url']![0]!
        .value,
    ).toEqual({ type: 'value', content: 'https://example.org/organization' });

    // Explicit scalar states retain their native meaning; whitespace-only citation removes the reference.
    const states = peopleProfileFixture();
    await render(editor(states));
    await choose('schema:Person');
    await terms('Explicit states');
    for (const [property, state] of [
      ['schema:birthDate', 'somevalue'],
      ['schema:deathDate', 'novalue'],
    ] as const) {
      const fieldset = await add(states, property);
      await act(async () =>
        user.selectOptions(within(fieldset).getByRole('combobox', { name: m.correction_value_state() }), state),
      );
      expect(within(fieldset).queryByRole('combobox', { name: m.correction_precision() })).toBeNull();
      const cite = citationInput(fieldset);
      await act(async () => {
        await user.type(cite, citation);
        await user.clear(cite);
        await user.type(cite, '   ');
      });
    }
    await submit();
    await waitFor(() => expect(states.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const stateItem = states.calls.find((call) => call.method === 'POST')!.body as PeopleCommand['item'];
    expect(stateItem.statements!['schema:birthDate']![0]!.value).toEqual({ type: 'somevalue' });
    expect(stateItem.statements!['schema:deathDate']![0]!.value).toEqual({ type: 'novalue' });
    expect(Object.values(stateItem.statements!).map((rows) => rows[0]!.references)).toEqual([[], []]);

    // Invalid scalar values name and focus the rejected input.
    const invalid = peopleProfileFixture();
    await render(editor(invalid));
    await choose('schema:Person');
    await terms('Invalid example');
    await add(invalid, 'wdt:P648');
    await value(invalid, 'wdt:P648', 'invalid-identifier');
    await submit();
    const correction = await waitFor(() => canvas().getByRole('link', { name: new RegExp(name(invalid, 'wdt:P648')) }));
    const rejectedInput = within(group('wdt:P648')).getByRole('textbox', { name: m.correction_value() });
    expect(correction.getAttribute('href')).toBe(`#${encodeURIComponent(rejectedInput.id)}`);
    await act(async () => user.click(correction));
    expect(window.document.activeElement).toBe(rejectedInput);
    expect(invalid.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(rejectedInput.getAttribute('aria-invalid')).toBe('true');

    for (const type of ['schema:Person', 'schema:Organization']) {
      const fixture = peopleProfileFixture();
      const supplied = await fixture.transport.load();
      if (!supplied.ok) throw new Error('Expected People metadata');
      let loads = 0;
      const commands: PeopleCommand[] = [];
      const readIds: string[] = [];
      const bad = '/statements/schema:url/0/references/0/parts/0/value/content';
      const unknown = [
        '/statements/schema:url/1/value/content',
        '/statements/schema:url/0/qualifiers/0/value/content',
        '/statements/schema:url/0/references/1/parts/0/value/content',
      ];
      const transport: PeopleTransport = {
        load: async () => (++loads === 2 ? { ok: false, reason: 'unavailable' } : supplied),
        create: async (command) => {
          commands.push(structuredClone(command));
          if (commands.length === 1)
            return {
              ok: false,
              reason: 'invalid',
              refreshDefinitions: true,
              errors: [bad, ...unknown].map((pointer) => ({ pointer, code: 'invalid_format' })),
            };
          const result = await fixture.transport.create(command);
          return result.ok ? { ...result, reader: { state: 'unavailable' } } : result;
        },
        read: async (id) => {
          readIds.push(id);
          return fixture.transport.read(id);
        },
      };
      await render(editor(fixture, transport));
      await choose(type);
      await terms('Cited person or organization');
      await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_add_language() })));
      await act(async () => {
        await user.type(host.querySelector('#create-language-1')!, 'ja');
        await user.type(host.querySelector('#create-label-1')!, '保持する名前');
      });
      await add(fixture, 'schema:url');
      await value(fixture, 'schema:url', 'https://example.org/person');
      await add(fixture, 'schema:sameAs');
      await value(fixture, 'schema:sameAs', 'https://example.org/sibling');
      const cite = citationInput(group('schema:url'));
      await act(async () => user.type(cite, 'https://example.org/rejected'));
      await submit();
      await waitFor(() => expect(host.textContent).toContain(m.correction_unavailable()));
      expect(canvas().getByRole('button', { name: m.catalogue_create_submit() }).hasAttribute('disabled')).toBe(true);
      const link = canvas().getByRole('link', {
        name: new RegExp(`${name(fixture, 'schema:url')}.*${m.correction_url()}`),
      });
      expect(link.getAttribute('href')).toBe(`#${encodeURIComponent(cite.id)}`);
      for (const pointer of unknown) {
        const details = Array.from(host.querySelectorAll('details')).find((node) =>
          node.textContent?.includes(pointer),
        )!;
        expect(details.closest('li')!.querySelector('a')).toBeNull();
      }
      await act(async () => user.click(link));
      expect(window.document.activeElement).toBe(cite);
      expect(cite.getAttribute('aria-invalid')).toBe('true');
      await act(async () => {
        await user.clear(cite);
        await user.type(cite, 'https://example.org/corrected');
      });
      await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
      await submit();
      await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
      expect(commands[1]!.key).not.toBe(commands[0]!.key);
      const expected = structuredClone(commands[0]!.item);
      expected.statements!['schema:url']![0]!.references[0]!.parts[0]!.value = {
        type: 'value',
        content: 'https://example.org/corrected',
      };
      expect(commands[1]!.item).toEqual(expected);
      expect(expected.labels).toEqual({ en: 'Cited person or organization', ja: '保持する名前' });
      await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
      await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
      expect(readIds).toEqual([peopleCreatedId]);
      expect(commands).toHaveLength(2);
      expect(canvas().getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
        ((await fixture.transport.read(peopleCreatedId)) as { state: 'ready'; href: string }).href,
      );
    }

    for (const type of ['schema:Person', 'schema:Organization']) {
      const fixture = peopleProfileFixture('uncertain');
      const supplied = await fixture.transport.load();
      if (!supplied.ok || !supplied.work) throw new Error('Expected work reference');
      let outcome: PeopleRead | Error = supplied;
      const commands: PeopleCommand[] = [];
      const transport: PeopleTransport = {
        ...fixture.transport,
        load: async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
        create: (command) => {
          commands.push(command);
          return fixture.transport.create(command);
        },
      };
      await render(editor(fixture, transport));
      await choose(type);
      await terms('Private recovery draft');
      await add(fixture, 'schema:url');
      await value(fixture, 'schema:url', url);
      const cite = citationInput(group('schema:url'));
      await act(async () => user.type(cite, citation));
      await submit();
      await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
      const original = structuredClone(fixture.calls.find((call) => call.method === 'POST'));
      const retryMetadata = async () =>
        act(async () =>
          user.click(
            canvas()
              .getAllByRole('button', { name: m.catalogue_create_retry() })
              .find((node) => node.getAttribute('type') !== 'submit')!,
          ),
        );
      for (const failure of [
        { ok: false, reason: 'unavailable' } as const,
        { ok: false, reason: 'denied' } as const,
        new Error('read failed'),
      ]) {
        outcome = failure;
        await act(async () => {
          await client.invalidateQueries({ queryKey: ['people-profile'] });
        });
        await waitFor(() => expect(host.querySelector('[data-slot="profile-work-reference"]')).toBeNull());
        expect(host.innerHTML).not.toContain(supplied.work.subject.id);
        expect(cite.isConnected).toBe(true);
        expect(cite.value).toBe(citation);
        expect(group('schema:url').disabled).toBe(true);
        expect((host.querySelector('#create-label-0') as HTMLInputElement).value).toBe('Private recovery draft');
        const wrong = structuredClone(supplied);
        wrong.work!.subject.id = peopleCreatedId;
        wrong.work!.subject.labels = { en: 'Wrong work must stay absent' };
        outcome = wrong;
        await retryMetadata();
        await waitFor(() => expect(host.textContent).toContain(m.correction_stale()));
        expect(host.textContent).not.toContain('Wrong work must stay absent');
        outcome = structuredClone(supplied);
        if (outcome.ok) outcome.work!.subject.labels = { en: 'Fresh matching work' };
        await retryMetadata();
        await waitFor(() => expect(host.textContent).toContain('Fresh matching work'));
        expect(commands).toHaveLength(1);
      }
      await act(async () => user.click(host.querySelector<HTMLButtonElement>('button[type="submit"]')!));
      await waitFor(() => expect(commands).toHaveLength(2));
      expect(commands[1]).toBe(commands[0]);
      expect(fixture.calls.filter((call) => call.method === 'POST')).toEqual([original, original]);
      expect(original?.authorization).toBe('Bearer fixture');
    }

    // Refresh removes a definition without erasing its draft, citation, visible stale meaning or Remove.
    const removed = peopleProfileFixture();
    const supplied = await removed.transport.load();
    if (!supplied.ok) throw new Error('Expected supplied creation metadata');
    const next = structuredClone(supplied);
    delete next.release.properties['schema:url'];
    delete next.release.types['schema:Organization'];
    next.profiles = peopleProfiles(next.release, 'en');
    let loads = 0;
    const commands: PeopleCommand[] = [];
    const removedTransport: PeopleTransport = {
      ...removed.transport,
      load: async () => (++loads === 1 ? supplied : next),
      create: async (command) => {
        commands.push(structuredClone(command));
        return {
          ok: false,
          reason: 'invalid',
          refreshDefinitions: true,
          errors: [{ pointer: '/statements/schema:url/0/value', code: 'unsupported' }],
        };
      },
    };
    await render(editor(removed, removedTransport));
    await choose('schema:Organization');
    await terms('Removed metadata');
    await add(removed, 'schema:url');
    await value(removed, 'schema:url', url);
    await act(async () => user.type(citationInput(group('schema:url')), citation));
    await submit();
    await waitFor(() => expect(group('schema:url').textContent).toContain(m.correction_stale()));
    expect(group('schema:url').querySelector('legend')!.textContent).toBe(m.candidate_value_unavailable());
    expect(within(group('schema:url')).queryByRole('textbox')).toBeNull();
    expect(group('schema:url').textContent).toContain(citation);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.statements!['schema:url']![0]!.value).toEqual({ type: 'value', content: url });
    expect(loads).toBe(2);
    await submit();
    expect(commands).toHaveLength(1); // Retired metadata cannot authorize a fresh command.
    expect((host.querySelector('#create-label-0') as HTMLInputElement).value).toBe('Removed metadata');
    await act(async () =>
      user.click(within(group('schema:url')).getByRole('button', { name: m.people_profile_remove_fact() })),
    );
    expect(group('schema:url')).toBeNull();

    for (const scenario of ['denied', 'uncertain', 'reader-unavailable', 'concealed'] as const) {
      const fixture = peopleProfileFixture(scenario);
      await render(editor(fixture));
      await choose('schema:Organization');
      await terms('Recovery example');
      await add(fixture, 'schema:url');
      await value(fixture, 'schema:url', url);
      await submit();
      if (scenario === 'denied') {
        await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_denied()));
        expect(
          (within(group('schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0] as HTMLInputElement)
            .value,
        ).toBe(url);
        expect(fixture.receipts.size).toBe(0);
      } else if (scenario === 'uncertain') {
        await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
        expect(group('schema:url').disabled).toBe(true);
        const frozen = structuredClone(fixture.calls.find((call) => call.method === 'POST'));
        await act(async () =>
          user.type(
            within(group('schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0]!,
            '/must-not-edit',
          ),
        );
        await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
        await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
        const writes = fixture.calls.filter((call) => call.method === 'POST');
        expect(writes).toHaveLength(2);
        expect(writes[0]).toEqual(frozen);
        expect(writes[1]).toEqual(frozen);
        expect(fixture.receipts.size).toBe(1);
      } else {
        await waitFor(() =>
          expect(host.textContent).toContain(
            scenario === 'concealed' ? m.catalogue_create_concealed() : m.catalogue_create_reader_unavailable(),
          ),
        );
        expect(host.textContent).toContain(peopleCreatedId);
        await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
        expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      }
    }
    for (const scenario of ['empty', 'stale', 'unavailable', 'loading'] as const) {
      const fixture = peopleProfileFixture(scenario);
      await render(editor(fixture));
      if (scenario !== 'loading')
        await waitFor(() =>
          expect(host.textContent).toContain(
            scenario === 'empty'
              ? m.catalogue_create_empty()
              : scenario === 'stale'
                ? m.correction_stale()
                : m.correction_unavailable(),
          ),
        );
      expect(fields()).toHaveLength(0);
      expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    }

    // Every authority epoch retires the pending command and its private workspace.
    for (const authority of [null, { subject: 'another-viewer' }, { csrfToken: 'another-csrf-session' }]) {
      const retiring = peopleProfileFixture();
      let finish!: (result: CreateResult) => void;
      let creates = 0;
      let readers = 0;
      let suspendRead = false;
      let finishRead!: (result: PeopleRead) => void;
      const retirementTransport: PeopleTransport = {
        ...retiring.transport,
        load: async () => {
          if (!suspendRead) return retiring.transport.load();
          suspendRead = false;
          return new Promise((resolve) => {
            finishRead = resolve;
          });
        },
        create: async () => {
          creates++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        read: async () => {
          readers++;
          return { state: 'unavailable' };
        },
      };
      await render(editor(retiring, retirementTransport));
      await choose('schema:Person');
      await terms('Retired draft sentinel');
      await add(retiring, 'schema:url');
      await value(retiring, 'schema:url', url);
      await submit();
      expect(creates).toBe(1);
      const navigationCount = navigations.length;
      suspendRead = true;
      await act(async () => {
        void client.invalidateQueries({ queryKey: ['people-profile'] });
      });
      const session = authority ? 'signed-in' : 'signed-out';
      await render(editor(retiring, retirementTransport, session), session, false, authority ?? {});
      const late = await retiring.transport.load();
      if (late.ok && late.work) late.work.subject.labels = { en: 'Late retired work sentinel' };
      await act(async () => {
        finishRead(late);
        finish({ ok: true, id: peopleCreatedId, reader: { state: 'ready', href: '/en/retired-sentinel' } });
      });
      await waitFor(() => expect(host.querySelector('#create-label-0')).not.toBeNull());
      if (!authority) expect(host.textContent).toContain(m.catalogue_create_signed_out());
      expect(host.innerHTML).not.toContain('Late retired work sentinel');
      expect(host.innerHTML).not.toContain('Retired draft sentinel');
      expect(host.innerHTML).not.toContain('/en/retired-sentinel');
      expect(canvas().queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
      expect(navigations).toHaveLength(navigationCount);
      expect(readers).toBe(0);
    }

    // Supplied-data growth only: 1/8/64 unrelated metadata rows and text chunks, not native/backend proof.
    // The already-supplied current profiles are bounded to the same two released families. Rendering
    // may address selected property keys, but cannot enumerate the whole property population or add IO.
    for (const size of [1, 8, 64]) {
      const fixture = peopleProfileFixture();
      const read = await fixture.transport.load();
      if (!read.ok) throw new Error('Expected supplied growth metadata');
      const label = `URL ${'長いNomميرا'.repeat(size)}`;
      read.release.properties['schema:url']!.labels.en = label;
      read.release.properties['schema:url']!.descriptions = { en: 'Full meaning '.repeat(size) };
      for (let index = 0; index < size; index++)
        read.release.properties[`unrelated:${index}`] = structuredClone(read.release.properties['schema:url']!);
      let enumerations = 0;
      read.release.properties = new Proxy(read.release.properties, {
        ownKeys: (target) => {
          enumerations++;
          return Reflect.ownKeys(target);
        },
      });
      let suppliedLoads = 0;
      const transport = {
        ...fixture.transport,
        load: async () => {
          suppliedLoads++;
          return read;
        },
      };
      await render(editor(fixture, transport));
      await choose('schema:Person');
      await act(async () =>
        user.click(canvas().getByRole('button', { name: m.people_profile_add_fact({ field: label }) })),
      );
      expect(group('schema:url').querySelector('h3')!.textContent).toBe(label);
      expect(group('schema:url').textContent).toContain('Full meaning '.repeat(size));
      expect(fields()).toHaveLength(1);
      expect(suppliedLoads).toBe(1);
      expect(enumerations).toBe(0);
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey[0])
          .sort(),
      ).toEqual(['catalogue-create', 'people-profile']);
    }
    const deferredRead = () => {
      let resolve!: (result: PeopleRead) => void;
      return { promise: new Promise<PeopleRead>((done) => (resolve = done)), resolve };
    };
    const retryFixture = peopleProfileFixture();
    const freshMetadata = await retryFixture.transport.load();
    if (!freshMetadata.ok) throw new Error('Expected fresh People creation metadata');
    const firstRead = deferredRead();
    const retriedRead = deferredRead();
    let retryLoads = 0;
    const retryTransport: PeopleTransport = {
      ...retryFixture.transport,
      load: async () => {
        const attempt = ++retryLoads;
        return attempt === 1 ? firstRead.promise : attempt === 2 ? retriedRead.promise : freshMetadata;
      },
    };
    await render(editor(retryFixture, retryTransport));
    expect(canvas().queryByRole('button', { name: m.catalogue_create_retry() })).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const initialFocus = window.document.activeElement;
    await act(async () => firstRead.resolve({ ok: false, reason: 'unavailable' }));
    const retryButton = await waitFor(() => canvas().getByRole('button', { name: m.catalogue_create_retry() }));
    expect(window.document.activeElement).toBe(initialFocus);
    retryButton.focus();
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(retryButton.getAttribute('aria-disabled')).toBe('true'));
    expect(canvas().getByRole('status').textContent).toContain(m.catalogue_create_loading());
    await act(async () => retryButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(retryLoads).toBe(2);
    await act(async () => retriedRead.resolve({ ok: false, reason: 'denied' }));
    await waitFor(() => expect(host.textContent).toContain(m.correction_denied()));
    await waitFor(() => expect(window.document.activeElement).toBe(retryButton));
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => canvas().getByRole('combobox', { name: m.catalogue_create_type() }));
    await waitFor(() => expect(window.document.activeElement).toBe(host.querySelector('h1')));
    expect(initialFocus).toBe(window.document.body);
    await choose('schema:Person');
    expect(host.querySelector('#create-label-0')).not.toBeNull();

    const retiredFixture = peopleProfileFixture();
    const personFixture = peopleProfileFixture('ready', 'en', 'person');
    const personRead = await personFixture.transport.load();
    if (!personRead.ok) throw new Error('Expected matching People profile metadata');
    const retiredCompletion = deferredRead();
    let retiredLoads = 0;
    const retiredTransport: PeopleTransport = {
      ...retiredFixture.transport,
      read: personFixture.transport.read,
      load: async () => {
        const attempt = ++retiredLoads;
        return attempt === 1
          ? { ok: false, reason: 'unavailable' }
          : attempt === 2
            ? retiredCompletion.promise
            : personRead;
      },
    };
    await render(editor(retiredFixture, retiredTransport));
    const retiredRetry = await waitFor(() => canvas().getByRole('button', { name: m.catalogue_create_retry() }));
    retiredRetry.focus();
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(retiredRetry.getAttribute('aria-disabled')).toBe('true'));
    await render(editor(personFixture, retiredTransport, 'signed-in', peoplePersonId), 'signed-in', false);
    await waitFor(() => expect(host.textContent).toContain('Mira Sato'));
    const profileHeading = await waitFor(() => host.querySelector('h1') as HTMLHeadingElement);
    profileHeading.focus();
    await act(async () => {
      retiredCompletion.resolve({ ok: false, reason: 'denied' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.document.activeElement).toBe(profileHeading);
    expect(host.textContent).not.toContain(m.correction_denied());
    expect(canvas().queryByRole('combobox', { name: m.catalogue_create_type() })).toBeNull();
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
}, 60_000);
