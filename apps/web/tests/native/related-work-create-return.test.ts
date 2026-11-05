import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { candidateContext } from '../../src/subject/candidates.ts';
import {
  beginRelatedWorkDraftReturn,
  claimRelatedWorkReturn,
  createRelatedWorkHandoff,
  isRelatedWorkGroup,
  readRelatedWorkHandoff,
  relatedWorkTargetAdmitted,
} from '../../src/features/catalogue/related-work-handoff.ts';
import type { RelationTransport } from '../../src/subject/relation-candidates.ts';

// Authored coverage of the production RelationEditor, generic create caller, and handoff.
// Executed here against request-seam fixtures, not a native host stack.
test('From an admitted non-credit work relationship, a contributor creates a missing native work, explicitly selects its reread identity back into the preserved relation draft, proposes/reviews the exact qualified relationship and returns to the current source subject without duplicate creation or inferred identity.', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/work/relation-edit', width: 390 });
  const assigned: string[] = [];
  window.location.assign = ((url: string) => {
    assigned.push(String(url));
  }) as typeof window.location.assign;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { RelationEditor } = await import('../../src/features/catalogue/relation-editor');
  const { RelatedWorkCreate } = await import('../../src/features/catalogue/related-work-handoff-view');
  const { relationFixture } = await import('../../src/kernel/fake/catalogue-relations');
  const { catalogueCreateFixture, catalogueCreatedId } = await import('../../src/kernel/fake/catalogue-create');
  const { ConnectedStory } = await import('../../src/stories/connected-story');
  const { m } = await import('../../src/paraglide/messages.js');
  const { setLocale } = await import('../../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const reader = 'reader-related-work';
  const citation = 'https://example.org/related-work-evidence';

  expect(relatedWorkTargetAdmitted('schema:Movie', ['schema:CreativeWork'], ['schema:CreativeWork'])).toBe(true);
  expect(relatedWorkTargetAdmitted('schema:Person', [], ['schema:CreativeWork'])).toBe(false);
  expect(claimRelatedWorkReturn(crypto.randomUUID(), crypto.randomUUID(), reader)).toBeUndefined();

  const fixture = relationFixture();
  const initial = await fixture.transport.read();
  if (!initial.ok) throw new Error('Expected relation read');
  const workField = initial.fields.find((field) => isRelatedWorkGroup(field.group));
  const creditField = initial.fields.find((field) => field.group === 'credit');
  if (!workField || !creditField) throw new Error('Expected released work-to-work and credit fields');

  let proposals = 0;
  const transport: RelationTransport = {
    ...fixture.transport,
    propose: async (input) => {
      proposals += 1;
      if (proposals === 1) return { ok: false, reason: 'denied' };
      return fixture.transport.propose(input);
    },
  };

  const renderEditor = async (props: Record<string, unknown> = {}) =>
    act(async () =>
      root.render(
        h(
          ConnectedStory,
          { storyId: 'related-work' },
          h(RelationEditor, {
            id: fixture.id,
            locale: 'en',
            initial,
            transport,
            search: async () => [],
            handoffReader: reader,
            handoffReaderLive: () => true,
            ...props,
          }),
        ),
      ),
    );
  const canvas = () => within(host);
  const click = async (name: string) => act(async () => user.click(canvas().getByRole('button', { name })));
  const select = async (label: string, value: string) =>
    act(async () => user.selectOptions(canvas().getByRole('combobox', { name: label }), value));

  try {
    await renderEditor();
    await select(m.relation_property(), creditField.id);
    expect(canvas().queryByRole('button', { name: m.relation_create_related_work() })).toBeNull();
    expect(canvas().getByRole('button', { name: m.relation_create_credit_target() })).toBeTruthy();

    await select(m.relation_property(), workField.id);
    expect(canvas().queryByRole('button', { name: m.relation_create_credit_target() })).toBeNull();
    await act(async () => user.type(canvas().getByLabelText(m.relation_citation()), citation));
    await click(m.relation_add_citation());
    await click(m.relation_create_related_work());
    const created = assigned.at(-1);
    if (!created) throw new Error('Expected generic creation navigation');
    const token = new URL(created, 'https://site.test').searchParams.get('relatedWorkHandoff');
    if (!token) throw new Error('Expected handoff token');
    expect(created).toContain('/en/catalogue/new');
    const stored = readRelatedWorkHandoff(token);
    expect(stored?.workId).toBe(fixture.id);
    expect(stored?.propertyId).toBe(workField.id);
    expect(stored?.draft.references[0]?.parts[0]?.value).toEqual({ type: 'value', content: citation });
    expect(stored?.draft.value).toEqual({ type: 'somevalue' });

    const other = createRelatedWorkHandoff({
      workId: fixture.id,
      sourceLabel: 'Source',
      reader: 'other-reader',
      context: candidateContext,
      releaseDigest: stored!.releaseDigest,
      propertyId: workField.id,
      propertyLabel: workField.label,
      group: stored!.group,
      targets: [...workField.targets],
      draft: structuredClone(stored!.draft),
      citation,
      rank: 'normal',
      qualifierIdentities: [],
    });
    expect(other && beginRelatedWorkDraftReturn(other.token, fixture.id, reader)).toBe(false);

    const create = catalogueCreateFixture('reader-unavailable');
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(RelatedWorkCreate, {
            locale: 'en',
            session: 'signed-in',
            transport: create.transport,
            onNavigate: () => {
              throw new Error('Created identity must not auto-open a reader');
            },
            token,
            reader,
            readerLive: () => true,
          }),
        ),
      ),
    );
    await waitFor(() => canvas().getByRole('textbox', { name: m.catalogue_create_label() }));
    expect(canvas().getByRole('textbox', { name: m.catalogue_create_label() })).toHaveProperty('value', '');
    expect(host.textContent).toContain(workField.label);
    const label = `Related work ${crypto.randomUUID().slice(0, 8)}`;
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), label));
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type_search_mode() }), 'id'),
    );
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_type_search() }), 'schema:Movie'),
    );
    await click(m.catalogue_create_type_search_action());
    await waitFor(() => canvas().getByRole('button', { name: new RegExp(m.catalogue_create_type_select()) }));
    await act(async () =>
      user.click(canvas().getByRole('button', { name: new RegExp(m.catalogue_create_type_select()) })),
    );
    await click(m.catalogue_create_submit());
    await waitFor(() => canvas().getByRole('button', { name: m.catalogue_create_retry() }));
    expect(create.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects')).toHaveLength(1);
    expect(canvas().queryByRole('button', { name: m.related_work_return_to_draft() })).toBeNull();
    create.setScenario('ready');
    await click(m.catalogue_create_retry());
    await waitFor(() => canvas().getByRole('button', { name: m.related_work_return_to_draft() }));
    expect(create.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects')).toHaveLength(1);
    expect(readRelatedWorkHandoff(token)?.identity?.id).toBe(catalogueCreatedId);
    await click(m.related_work_return_to_draft());
    const returned = assigned.at(-1);
    if (!returned) throw new Error('Expected relation-edit return');
    expect(returned).toContain('/relation-edit');
    expect(new URL(returned, 'https://site.test').searchParams.get('relatedWorkHandoff')).toBe(token);

    const returning = claimRelatedWorkReturn(token, fixture.id, reader);
    if (!returning?.identity) throw new Error('Expected claimed related-work return');
    await renderEditor({ relatedWorkHandoff: returning });
    await waitFor(() => canvas().getByRole('button', { name: m.relation_use_created_work() }));
    expect((canvas().getByRole('combobox', { name: m.relation_target() }) as HTMLInputElement).value).toBe('');
    expect(host.textContent).toContain(citation);
    await click(m.relation_use_created_work());
    await waitFor(() =>
      expect((canvas().getByRole('combobox', { name: m.relation_target() }) as HTMLInputElement).value).toContain(
        returning.identity!.label,
      ),
    );
    await click(m.relation_propose());
    const confirm = canvas().getByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) });
    await act(async () => user.click(within(confirm).getByRole('button', { name: m.relation_propose() })));
    await waitFor(() => canvas().getByRole('alert'));
    expect(canvas().queryByRole('button', { name: m.relation_create_related_work() })).toBeNull();
    expect(proposals).toBe(1);
    expect(create.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
