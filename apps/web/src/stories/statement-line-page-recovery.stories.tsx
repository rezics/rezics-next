import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState, type ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorStatementPage } from '../checkout/creator-statement-page';
import { CreatorStatementCurrent } from '../checkout/creator-statements-current';
import { creatorLineFixture, creatorStatementFixture } from '../kernel/fake/creator-statements';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Catalogue/Statement Line Pages',
  id: 'patterns-statement-line-pages',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'UNRUN illustrative statement-line recovery cases. These render the actual page and, for admission cases, its existing current-reader boundary. Supplied fixtures do not establish native authorization, payment, settlement, browser or visual acceptance. Locale and theme remain globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type View = ComponentProps<typeof CreatorStatementPage>;
const id = creatorStatementFixture.id.toUpperCase();
const cursor = ' signed/lines+page?filter=refund&locale=ja#二% ';
const from = ' signed/statements+page?period=2026-10&locale=fr#三% ';
const next = ' signed/next+lines?from=else&locale=de#四% ';
const statement = { ...creatorStatementFixture, id };
const empty = (later = false, continuation: string | null = null): View => ({
  id,
  locale: getLocale(),
  from,
  ...(later ? { cursor } : {}),
  page: { kind: 'ready', statement, lines: { kind: 'ready', lines: [], next: continuation } },
});
function render(view: View) {
  return (
    <PatternStory visitor="Signed In" path={`/creator/statements/${id}`}>
      <main>
        <CreatorStatementPage {...view} />
      </main>
    </PatternStory>
  );
}
function ready(label: () => string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expect(await within(canvasElement).findByRole('heading', { name: label() })).toBeVisible();
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.statements_lines_empty());
  };
}

export const FirstEmpty: Story = {
  render: () => render(empty()),
  play: async (context) => {
    await ready(m.statement_line_page_reader_first_empty)(context);
    const view = within(context.canvasElement);
    await expect(view.queryByRole('link', { name: m.statements_restart_lines() })).not.toBeInTheDocument();
    await expect(view.queryByRole('link', { name: m.statements_next_lines() })).not.toBeInTheDocument();
  },
};
export const LaterEmpty: Story = {
  render: () => render(empty(true)),
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const view = within(context.canvasElement);
    await expect(view.getByRole('link', { name: m.statements_restart_lines() })).toBeVisible();
    await expect(view.queryByRole('link', { name: m.statements_next_lines() })).not.toBeInTheDocument();
  },
};
export const LaterEmptyWithContinuation: Story = {
  render: () => render(empty(true, next)),
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const view = within(context.canvasElement);
    await expect(view.getByRole('link', { name: m.statements_restart_lines() })).toBeVisible();
    await expect(view.getByRole('link', { name: m.statements_next_lines() })).toBeVisible();
  },
};
export const FirstEmptyWithContinuation: Story = {
  render: () => render(empty(false, next)),
  play: ready(m.statement_line_page_reader_page_empty),
};
export const FirstAndNextPreserveAddress: Story = {
  ...LaterEmptyWithContinuation,
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const view = within(context.canvasElement);
    for (const [label, expected] of [
      [m.statements_restart_lines(), [['from', from]]],
      [
        m.statements_next_lines(),
        [
          ['cursor', next],
          ['from', from],
        ],
      ],
      [
        m.statements_refresh(),
        [
          ['cursor', cursor],
          ['from', from],
        ],
      ],
    ] as const) {
      const link = view.getByRole('link', { name: label });
      const target = new URL(link.getAttribute('href')!, window.location.origin);
      await expect(decodeURIComponent(target.pathname)).toBe(`/${getLocale()}/creator/statements/${id}`);
      await expect([...target.searchParams]).toEqual(expected);
      link.focus();
      await expect(link).toHaveFocus();
    }
    const back = new URL(
      view.getByRole('link', { name: m.statements_back() }).getAttribute('href')!,
      window.location.origin,
    );
    await expect([...back.searchParams]).toEqual([['cursor', from]]);
  },
};
export const UnknownFinancialMetadata: Story = {
  render: () =>
    render({
      ...empty(true),
      page: {
        kind: 'ready',
        statement: { ...statement, moneyUnit: null, state: 'paid', paidAt: null, paidReference: null },
        lines: { kind: 'ready', lines: [], next: null },
      },
    }),
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const view = within(context.canvasElement);
    await expect(view.getAllByText(m.statements_amount_unavailable())).toHaveLength(9);
    await expect(view.getAllByText(m.statements_unknown(), { exact: true })).toHaveLength(2);
    await expect(view.getByText(m.statements_funds_unknown())).toBeVisible();
  },
};
export const LinesError: Story = {
  render: () => render({ ...empty(true), page: { kind: 'ready', statement, lines: { kind: 'error' } } }),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.statements_error());
    await expect(view.queryByText(m.statements_lines_empty())).not.toBeInTheDocument();
    await expect(view.getByRole('link', { name: m.statements_restart_lines() })).toBeVisible();
  },
};
export const Preparing: Story = {
  render: () => render({ ...empty(true), page: { kind: 'preparing' } }),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.statements_preparing());
    await expect(view.queryByText(m.statements_lines_empty())).not.toBeInTheDocument();
  },
};
export const NarrowLongText: Story = {
  globals: {},
  render: () =>
    render({
      ...empty(true, next),
      page: {
        kind: 'ready',
        statement: {
          ...statement,
          state: 'paid',
          paidAt: null,
          paidReference:
            'Retained external reference / ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        },
        lines: { kind: 'ready', lines: [], next },
      },
    }),
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    for (const label of [m.statements_restart_lines(), m.statements_next_lines()]) {
      const link = within(main).getByRole('link', { name: label });
      await expect(link).toBeVisible();
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
};
export const OriginalLineOrderAndMultiplicity: Story = {
  render: () =>
    render({
      ...empty(),
      page: {
        kind: 'ready',
        statement,
        lines: {
          kind: 'ready',
          next,
          lines: [
            {
              ...creatorLineFixture,
              statementId: id,
              balanceTransactionId: 'txn_refund',
              kind: 'refund',
              netReceiptsMinor: -1100,
            },
            { ...creatorLineFixture, statementId: id },
            { ...creatorLineFixture, statementId: id },
          ],
        },
      },
    }),
  play: async ({ canvasElement }) => {
    const rows = within(await within(canvasElement).findByRole('list')).getAllByRole('listitem');
    await expect(rows.map((row) => within(row).getByRole('heading', { level: 3 }).textContent)).toEqual([
      m.statements_refund(),
      m.statements_charge(),
      m.statements_charge(),
    ]);
  },
};

function AuthorityExample({ admitted }: { admitted: boolean }) {
  const client = useQueryClient();
  const [prepared, setPrepared] = useState(false);
  const view = empty(true, next);
  const changeAdmission = (open: boolean) => {
    const snapshot = viewerExposureLifetime(client).getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected current viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted: open ? ['selling'] : [],
    });
  };
  useLayoutEffect(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: statement.creatorAccountId,
      csrfToken: 'story-current-credential',
    });
    const release = viewerExposureLifetime(client).subscribe(() => {});
    changeAdmission(admitted);
    setPrepared(true);
    return release;
  }, [client, admitted]);
  return (
    <main>
      {admitted ? (
        <button type="button" onClick={() => changeAdmission(false)}>
          Withdraw read admission
        </button>
      ) : null}
      {prepared ? (
        <CreatorStatementCurrent
          {...view}
          initial={{
            sessionSubject: statement.creatorAccountId,
            requested: { kind: 'detail', locale: getLocale(), id, cursor, from },
            page: { kind: 'ready', statement, lines: { kind: 'ready', lines: [], next } },
          }}
        />
      ) : (
        <CreatorStatementPage {...view} page={{ kind: 'preparing' }} />
      )}
    </main>
  );
}
export const ReadAuthorityAbsent: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <AuthorityExample admitted={false} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.statements_denied());
    await expect(view.queryByText(m.statements_lines_empty())).not.toBeInTheDocument();
  },
};
export const ReadAuthorityRetired: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <AuthorityExample admitted />
    </PatternStory>
  ),
  play: async (context) => {
    await ready(m.statement_line_page_reader_page_empty)(context);
    const view = within(context.canvasElement);
    await userEvent.click(view.getByRole('button', { name: 'Withdraw read admission' }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.statements_denied());
    await expect(view.queryByText(m.statements_lines_empty())).not.toBeInTheDocument();
    await expect(view.queryByRole('navigation', { name: m.statements_line_pagination() })).not.toBeInTheDocument();
  },
};
