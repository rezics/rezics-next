import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { AppShell } from '../shell/app-shell';
import { RouteLoading, type PendingLayout } from '../shell/pending';
import { RouteState } from '../shell/route-state';
import { m } from '../paraglide/messages.js';
import { shellErrorReads } from '../kernel/fake/shell-errors';
import offer from '../kernel/recorded/offer.json';
import { PatternStory } from './page';
import { ErrorStory, errorReady, StillUnavailable, Closed as ClosedOutcome, NotFound } from './shell-errors.stories';

const meta = {
  title: 'Site Shell/Route recovery',
  id: 'pages-shell-route-recovery',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function keyboardRecovery(context: { canvasElement: HTMLElement }) {
  const main = await errorReady(context);
  const retry = main.getByRole('button', { name: m.status_retry() });
  await waitFor(() => expect(retry).toBeEnabled());
  retry.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(shellErrorReads()).toBe(2));
  await expect(await main.findByRole('heading', { name: offer.offer.title })).toBeVisible();
  await expect(within(context.canvasElement).getAllByRole('main')).toHaveLength(1);
}

export const Retry: Story = {
  render: () => <ErrorStory outcome="unavailable" />,
  play: keyboardRecovery,
};

export const FailedRetry: Story = { ...StillUnavailable };

export const Closed: Story = { ...ClosedOutcome };

export const Missing: Story = { ...NotFound };

/** Prepared shell states, without pretending that a recording is a native pending request. */
function PreparedLoading({ layout }: { layout: PendingLayout }) {
  const [left, setLeft] = useState(false);
  return (
    <PatternStory visitor="Signed Out">
      <AppShell>
        <div data-prepared-route-state="true">
          {left ? <RouteState kind="missing" /> : <RouteLoading layout={layout} />}
          <aside aria-label="Prepared fixture controls" className="mt-8 border-t border-border pt-4">
            <button className="min-h-11 rounded-lg border border-border px-4" onClick={() => setLeft(true)}>
              Prepared fixture: leave loading
            </button>
          </aside>
        </div>
      </AppShell>
    </PatternStory>
  );
}

async function pendingReady({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const main = await canvas.findByRole('main');
  const busy = main.querySelector('[aria-busy="true"]');
  await expect(busy).toBeVisible();
  await expect(main.querySelectorAll('[data-skeleton-block]').length).toBeLessThanOrEqual(12);
  await expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  const control = within(main).getByRole('button', { name: 'Prepared fixture: leave loading' });
  control.focus();
  await userEvent.keyboard('{Enter}');
  await expect(await within(main).findByRole('heading', { name: m.not_found_heading() })).toBeVisible();
  await expect(canvas.getByRole('main')).toBe(main);
  await expect(main.querySelector('[aria-busy="true"]')).toBeNull();
}
export const Feed: Story = { render: () => <PreparedLoading layout="feed" />, play: pendingReady };

export const Detail: Story = {
  render: () => <PreparedLoading layout="detail" />,
  play: pendingReady,
};

export const Form: Story = { render: () => <PreparedLoading layout="form" />, play: pendingReady };

export const Generic: Story = {
  render: () => <PreparedLoading layout="page" />,
  play: pendingReady,
};

function LongRecovery() {
  return (
    <PatternStory visitor="Signed Out">
      <AppShell>
        <RouteState
          heading={m.error_heading()}
          message={Array(4).fill(m.route_error_description()).join(' ')}
          recovery={m.route_retry_later()}
        />
      </AppShell>
    </PatternStory>
  );
}
export const LongStrings: Story = {
  globals: { locale: 'de' },
  render: () => <LongRecovery />,
  play: async ({ canvasElement }) => {
    const main = await within(canvasElement).findByRole('main');
    await expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const home = within(main).getByRole('link', { name: m.status_home() });
    home.focus();
    await userEvent.tab();
    await expect(within(main).getByRole('link', { name: m.status_search() })).toHaveFocus();
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  },
};
