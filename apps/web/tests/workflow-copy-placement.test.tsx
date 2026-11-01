import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { ProgressSessionPage as ProgressPage } from '../src/library/progress-reads';
import { profileSession } from '../src/kernel/fake/progress-profiles';
import {
  creatorLineFixture,
  creatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';

// UNRUN under minimal verification. These composed UI assertions are not native or browser evidence.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/progress', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  CSS: window.CSS,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { CopyEditionPicker } = await import('../src/library/copy-edition-picker');
const { ProgressSessionPage } = await import('../src/library/progress-session');
const { EditionPublication } = await import('../src/content-editions/edition-create-view');
const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');
const { publicationFixture, editionId } =
  await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
const user = userEvent.setup({ document: window.document as unknown as Document });

beforeEach(async () => {
  setLocale('en', { reload: false });
  host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'owner', csrfToken: 'owner-csrf' });
  client.setQueryData(['exposure', 'viewer'], ['reading_progress']);
  client.setQueryData(['exposure', 'anonymous'], []);
  router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});
afterAll(async () => {
  mock.restore();
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function show(children: ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>{children}</RouterContextProvider>
      </QueryClientProvider>,
    ),
  );
}

test('Edition search keeps a direct associated instruction and local 64-character validation', async () => {
  const onChange = mock();
  await show(<CopyEditionPicker value={null} disabled={false} onChange={onChange} />);
  const canvas = within(host);
  const input = canvas.getByRole('combobox', { name: m.library_copy_edition() });
  const hint = window.document.getElementById(input.getAttribute('aria-describedby')!);
  expect(hint?.textContent).toBe('Search editions by title.');
  expect(hint?.closest('[hidden], details')).toBeNull();
  await act(async () => user.type(input, 'x'.repeat(65)));
  expect(canvas.getByRole('status').textContent).toBe(m.library_copy_lookup_limit());
  expect(input.getAttribute('aria-describedby')).toBe(hint!.id);
  expect((input as HTMLInputElement).value).toBe('x'.repeat(65));
  expect(onChange.mock.calls.at(-1)).toEqual([null]);
});

test('Unverified saved positions retain sparse completed units and exact cursor session meaning', async () => {
  const page: Extract<ProgressPage, { signedIn: true }> = {
    signedIn: true,
    idempotencyKey: 'retained-progress-intent',
    changesCursor: 'current-changes',
    unitsCursor: 'current-units',
    session: {
      ...profileSession,
      mode: 'completed_units',
      state: 'active',
      unit: 'chapter',
      unitLabel: 'chapters',
      meaning: 'known',
      recordingState: 'supported',
      amount: null,
      total: null,
      completedUnitCount: 2,
      units: ['chapter:2', 'chapter:19~alternate'],
      unitsNext: 'next-units',
      changes: [
        {
          id: 'change-1',
          revision: 7,
          createdAt: '2026-10-30T12:13:00Z',
          action: null,
          amount: null,
          locator: null,
          position: null,
          add: ['chapter:19~alternate'],
          remove: [],
        },
      ],
      changesNext: null,
    },
  };
  await show(<ProgressSessionPage page={page} />);
  const canvas = within(host);
  const warning = 'This saved position hasn’t been checked against the current work.';
  expect(canvas.getByText(warning).closest('details, [hidden]')).toBeNull();
  const units = canvas.getByRole('region', { name: m.library_progress_units() });
  expect([...units.querySelectorAll('li')].map((item) => item.textContent)).toEqual(page.session.units);
  expect(host.querySelector('[data-slot="progress-row"]')?.textContent).toContain('2');
  const more = within(units).getByRole('link', { name: m.library_progress_more() });
  const href = new URL(more.getAttribute('href')!, window.location.href);
  expect(href.pathname).toContain(page.session.id);
  expect(href.searchParams.get('units')).toBe('next-units');
  expect(href.searchParams.get('changes')).toBe('current-changes');
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  await act(async () => user.click(details.querySelector('summary')!));
  expect(details.open).toBe(true);
  expect(details.textContent).toContain('completed_units / chapter');
  expect(canvas.getByRole('region', { name: m.library_progress_changes() }).textContent).toContain(
    'chapter:19~alternate',
  );

  await show(
    <ProgressSessionPage
      key="cursor"
      page={{
        ...page,
        session: { ...page.session, mode: 'cursor_position', locator: 'Appendix B · second reading', position: '17.5' },
      }}
    />,
  );
  expect(canvas.getByText(warning).closest('details, [hidden]')).toBeNull();
  expect(canvas.getByText('Appendix B · second reading').closest('details, [hidden]')).toBeNull();
  expect(host.querySelector('[data-slot="progress-row"]')?.textContent).toContain('17.5');
  expect(host.querySelector('details')?.textContent).toContain('cursor_position / chapter');
  expect([...host.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual(page.session.units);
  await show(
    <ProgressSessionPage
      key="scalar"
      page={{
        ...page,
        session: { ...page.session, mode: 'scalar_amount', amount: '2.5', total: '10' },
      }}
    />,
  );
  expect(canvas.queryByText(warning)).toBeNull();
});

test('Saved publication with an unavailable read recovers through Refresh without repeating the command', async () => {
  const fixture = await publicationFixture('draft');
  fixture.failPublicationRead();
  await show(<EditionPublication controller={fixture.controller} />);
  const canvas = within(host);
  await act(async () => user.click(canvas.getByRole('checkbox')));
  await act(async () => user.click(canvas.getByRole('button', { name: m.edition_publication_publish() })));
  expect(canvas.getByRole('alert').textContent).toBe(
    'Saved. We couldn’t load the current edition. Refresh to check it.',
  );
  expect(canvas.queryByRole('heading', { name: m.edition_publication_published_heading() })).toBeNull();
  expect(canvas.queryByRole('button', { name: m.edition_publication_retry() })).toBeNull();
  expect(canvas.queryByRole('button', { name: m.edition_publication_publish() })).toBeNull();
  const retained = fixture.controller.snapshot();
  expect(retained.failure?.receipt?.editionId).toBe(editionId);
  const commands = fixture.calls.filter((call) => call.method === 'POST' && call.path.includes('contentEditions'));
  expect(commands).toHaveLength(2);
  const refresh = canvas.getByRole('button', { name: m.edition_publication_refresh() });
  await act(async () => user.click(refresh));
  expect(fixture.controller.snapshot().intent).toBe(retained.intent);
  expect(fixture.controller.snapshot().failure?.receipt).toEqual(retained.failure?.receipt);
  expect(canvas.getByRole('alert').textContent).toContain('Saved.');
  fixture.restoreRead();
  await act(async () => user.click(canvas.getByRole('button', { name: m.edition_publication_refresh() })));
  expect(canvas.queryByRole('alert')).toBeNull();
  const published = canvas.getByRole('status');
  expect(published.textContent).toContain('Your edition is published.');
  expect(published.textContent).toContain('夜の航路');
  const edition = fixture.controller.snapshot().edition!;
  const details = published.querySelector('details')!;
  expect(details.open).toBe(false);
  expect([...details.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
    editionId,
    edition.targetSubjectId,
    edition.revisionId,
    edition.editionRevision,
    edition.sha256,
  ]);
  expect(host.textContent).toContain(edition.licence);
  expect(canvas.getByRole('link', { name: m.edition_publication_open() }).getAttribute('href')).toBe(
    `/en/editions/${editionId}`,
  );
  expect(canvas.getByRole('link', { name: m.edition_publication_create_offer() }).getAttribute('href')).toBe(
    `/en/creator/offers/new?editionId=${editionId}`,
  );
  expect(fixture.calls.filter((call) => call.method === 'POST' && call.path.includes('contentEditions'))).toEqual(
    commands,
  );
});

test('Statement sources start closed and open by keyboard while money, times and payment meaning stay visible', async () => {
  const line = creatorLineFixture;
  const props = {
    id: creatorStatementFixture.id,
    locale: 'en',
    cursor: 'line/page+==',
    from: 'statement/page+==',
    page: {
      kind: 'ready' as const,
      statement: creatorStatementFixture,
      lines: { kind: 'ready' as const, lines: [line], next: 'next/line+==' },
    },
  };
  await show(<CreatorStatementPage {...props} />);
  const canvas = within(host);
  const row = host.querySelector('ul > li')!;
  const source = within(row as HTMLElement).getByRole('button', { name: 'Source details' });
  const panel = window.document.getElementById(source.getAttribute('aria-controls')!)!;
  expect(source.getAttribute('aria-expanded')).toBe('false');
  expect(panel.hidden).toBe(true);
  expect(row.querySelector('h3')?.textContent).toBe(m.statements_charge());
  const ledger = row.querySelector('dl')!;
  expect([...ledger.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
    m.statements_recording_month(),
    m.statements_royalty_basis(),
    m.statements_created(),
    m.statements_recorded(),
    m.statements_gross(),
    m.statements_tax(),
    m.statements_fee(),
    m.statements_dispute_fee(),
    m.statements_net(),
  ]);
  expect([...ledger.querySelectorAll('dd')].map((node) => node.textContent).slice(-5)).toEqual([
    '$10.00',
    '$2.00',
    '$0.50',
    '$0.00',
    '$7.50',
  ]);
  expect(ledger.textContent).toContain('2026-10');
  expect(ledger.textContent).toContain('9,000');
  expect([...ledger.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([line.created, line.recordedAt]);
  expect(ledger.closest('[hidden]')).toBeNull();
  expect(canvas.getByText(m.statements_open()).closest('[hidden]')).toBeNull();
  expect(host.textContent).toContain('October 2026 · USD');
  for (const label of [
    m.statements_accounting_note(),
    m.statements_payment_meaning(),
    m.statements_funds_unknown(),
    m.statements_lines_note(),
  ])
    expect(canvas.getByText(label).closest('[hidden]')).toBeNull();
  await act(async () => {
    source.focus();
    await user.keyboard('{Enter}');
  });
  expect(source.getAttribute('aria-expanded')).toBe('true');
  expect(panel.hidden).toBe(false);
  expect([...panel.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
    m.statements_transaction(),
    m.statements_order_source(),
    m.statements_offer_source(),
  ]);
  const references = [...panel.querySelectorAll('dd')];
  expect(references.map((node) => node.textContent)).toEqual([line.balanceTransactionId, line.orderId, line.offerId]);
  for (const node of references) {
    expect(node.classList.contains('select-all')).toBe(true);
    expect(node.classList.contains('break-all')).toBe(true);
  }
  await act(async () => user.keyboard(' '));
  expect(source.getAttribute('aria-expanded')).toBe('false');
  const refresh = canvas.getByRole('link', { name: m.statements_refresh() });
  expect([...new URL(refresh.getAttribute('href')!, window.location.href).searchParams]).toEqual([
    ['cursor', props.cursor],
    ['from', props.from],
  ]);
  const next = canvas.getByRole('link', { name: m.statements_next_lines() });
  expect([...new URL(next.getAttribute('href')!, window.location.href).searchParams]).toEqual([
    ['cursor', props.page.lines.next],
    ['from', props.from],
  ]);
  const provenance = canvas.getByRole('button', { name: m.statements_provenance() });
  expect(provenance.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelectorAll('[data-slot="accordion"]')).toHaveLength(2);

  await show(<CreatorStatementPage {...props} page={{ ...props.page, statement: paidCreatorStatementFixture }} />);
  expect(canvas.getByText(m.statements_paid()).closest('[hidden]')).toBeNull();
  expect(canvas.getByText(paidCreatorStatementFixture.paidReference!).closest('[hidden]')).toBeNull();
  expect(host.querySelector(`time[datetime="${paidCreatorStatementFixture.paidAt}"]`)?.closest('[hidden]')).toBeNull();
});
