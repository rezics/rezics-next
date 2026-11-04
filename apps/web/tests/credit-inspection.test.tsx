import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { relationFixture, relationActor, relationProperty } from '../src/kernel/fake/catalogue-relations';
import { creditAssertion, creditCorrection, type CreditVisit } from '../src/features/catalogue/credit-inspection/model';
import type { DetailRead } from '../src/features/catalogue/subject-changes';
import type { RowValue } from '../src/features/pages/overview';

const fixture = relationFixture();
fixture.candidate.id = fixture.original.id;
fixture.candidate.statement = structuredClone(fixture.original);
// The authorized draft may contain a part omitted from public disclosure. Never rebuild it from the row.
fixture.candidate.statement.qualifiers.push({ property: { id: 'wdt:P518', data_type: 'wikibase-item' },
  value: { type: 'value', content: '00000000-0000-8000-8000-000000000999' } });
const row = { subject: fixture.id, property: relationProperty, statement: fixture.original.id,
  assertion: fixture.original, creditSlot: fixture.slot, label: 'Original work',
  related: Object.fromEntries(Object.entries(fixture.publicRead.related).map(([id, value]) =>
    [id, { id, type: value.type, label: { value: value.labels.en, language: 'en' } }])) };
const credit = creditAssertion(row)!;
const visit: CreditVisit = { person: relationActor, node: 'voice', context: fixture.publicRead.subject.context,
  stream: { kind: 'links', id: relationActor, property: relationProperty, limit: 20 },
  reader: null, release: fixture.publicRead.subject.release, propertyLabel: 'Voice actor' };
let metadataResult: DetailRead = { kind: 'unavailable' };
let metadataRead = () => Promise.resolve(metadataResult);
const envelopes: any[] = [];
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/features/catalogue/credit-inspection/actions', () => ({
  loadCreditRevision: (input: any) => { envelopes.push(input); return metadataRead(); },
}));
mock.module('../src/features/catalogue/relation-editor-actions', () => ({
  readSubjectRelationEditor: ({ data }: any) => fixture.transport.read(data.slot, data.cursor, data.session),
  proposeSubjectRelation: ({ data }: any) => fixture.transport.propose(data),
  confirmSubjectRelation: ({ data }: any) => fixture.transport.confirm(data),
}));

// A real mounted card/inspector/editor; native transport responses are controlled fixtures.
test('inspect original credit, retain authorized draft and citations, retry metadata and return to the same row', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en' });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node, Text: window.Text,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver, DOMRect: window.DOMRect, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CoverList } = await import('../src/features/pages/cover-list');
  const { holderItems } = await import('../src/features/pages/overview');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { defaultReader } = await import('../src/subject/reader');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: '00000000-0000-8000-8000-000000000010', csrfToken: 'A'.repeat(22) });
  const plain = { ...row, statement: fixture.sibling.id, assertion: { ...fixture.sibling, qualifiers: [], references: [] }, creditSlot: { property: relationProperty, target: relationActor } };
  const items = holderItems({ links: [row, plain], next: 'opaque-original-window' }, 20)!.items;
  const value: RowValue = { locale: 'en', link: (props) => h('a', props), reader: defaultReader,
    labels: { spoilerShow: 'Show', documentSpoiler: 'Spoiler', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    unlabelled: 'Unlabelled', spoilerShow: 'Show' };
  const render = (selectedVisit = visit) => act(async () => root.render(h(QueryClientProvider, { client },
    h(CoverList, { items, value, label: 'Voice credits', creditVisit: selectedVisit }))));
  const button = (name: string) => [...window.document.querySelectorAll('button')].find((node) => node.textContent === name)!;
  const click = async (name: string) => act(async () => { button(name).click(); });
  try {
    await render();
    expect(fixture.calls).toHaveLength(0);
    const opener = button(m.credit_inspect());
    opener.focus();
    await click(m.credit_inspect());
    await act(async () => { await import('../src/features/catalogue/credit-inspection/session'); });
    expect(window.document.body.textContent).toContain('https://example.org/credits');
    expect(window.document.body.textContent).toContain(fixture.original.id);
    expect(window.document.body.textContent).toContain(m.credit_proposal_meaning());
    await click(m.credit_read_revision());
    expect(window.document.body.textContent).toContain(m.credit_revision_unavailable());
    expect(envelopes[0].data).toMatchObject({ id: fixture.id, revision: fixture.original.rezics.revision });
    await click(m.credit_correct());
    const named = [...window.document.querySelectorAll('input')].find((input) => input.value === 'Original credit')!;
    expect(named.disabled).toBe(false);
    const propose = button(m.relation_propose());
    expect(propose.disabled).toBe(false);
    await click(m.relation_propose());
    const confirmation = [...window.document.querySelectorAll('[role="group"]')].find((node) =>
      node.getAttribute('aria-label') === m.candidate_confirm_title({ action: m.relation_propose() }))!;
    await act(async () => { (confirmation.querySelector('button') as HTMLButtonElement).click(); });
    const write = fixture.calls.find((call) => call.method === 'POST' && call.path.endsWith('/candidates'))!;
    expect((write.body as any).statement.qualifiers).toContainEqual({ property: { id: 'wdt:P518' }, value: { type: 'value', content: '00000000-0000-8000-8000-000000000999' } });
    expect(window.document.body.textContent).toContain(m.relation_proposed());
    await click(m.work_parts_draft_close());
    if (button(m.work_parts_draft_discard())) await click(m.work_parts_draft_discard());
    await click(m.credit_close());
    expect(window.document.activeElement).toBe(opener);
    expect(host.querySelectorAll('[data-statement]')).toHaveLength(2);
    // A late exact metadata response cannot attach after a visit leaves and returns to the same address.
    let finish!: (detail: DetailRead) => void;
    metadataRead = () => new Promise((resolve) => { finish = resolve; });
    await click(m.credit_inspect());
    await click(m.credit_read_revision());
    await render({ ...visit, person: '00000000-0000-8000-8000-000000000020' });
    await render();
    await act(async () => finish({ kind: 'ready', detail: { id: fixture.id, revision: 1, summary: { kind: 'limited' } } }));
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});

test('plain assertions and refused or absent correction authority preserve independently disclosed citations', async () => {
  const native = await fixture.transport.read(fixture.slot);
  expect(creditCorrection(credit, visit, { ok: false, reason: 'denied' })).toEqual({ state: 'denied' });
  expect(creditCorrection(credit, visit, native).state).toBe('ready');
  if (native.ok) expect(creditCorrection(credit, visit, { ...native, page: { ...native.page!, candidates: [], next: 'do-not-page' } }).state).toBe('unavailable');
  expect(credit.statement.references).toHaveLength(1);
  const plain = creditAssertion({ ...row, assertion: { ...fixture.original, qualifiers: [], references: [] } })!;
  expect(plain.statement.references).toEqual([]);
  expect(creditAssertion({ ...row, property: 'schema:author' })).toBeUndefined();
});
