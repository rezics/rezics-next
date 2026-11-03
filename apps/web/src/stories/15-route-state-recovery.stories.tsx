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
import { ErrorStory, errorReady, StillUnavailable, Closed, NotFound } from './shell-errors.stories';

const meta = {
  title: 'Pages/Shell/Route recovery',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone390' }, theme: 'light' };
const desktop = { viewport: { value: 'desktop1280' }, theme: 'dark' };

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

export const RetryPhone: Story = {
  globals: phone,
  render: () => <ErrorStory outcome="unavailable" />,
  play: keyboardRecovery,
};
export const RetryDesktop: Story = { ...RetryPhone, globals: desktop };
export const FailedRetryPhone: Story = { ...StillUnavailable, globals: { ...phone, theme: 'dark' } };
export const FailedRetryDesktop: Story = { ...StillUnavailable, globals: { ...desktop, theme: 'light' } };
export const ClosedPhone: Story = { ...Closed, globals: phone };
export const ClosedDesktop: Story = { ...Closed, globals: desktop };
export const MissingPhone: Story = { ...NotFound, globals: { ...phone, theme: 'dark' } };
export const MissingDesktop: Story = { ...NotFound, globals: { ...desktop, theme: 'light' } };

/** Prepared shell states, without pretending that a recording is a native pending request. */
function PreparedLoading({ layout }: { layout: PendingLayout }) {
  const [left, setLeft] = useState(false);
  return <PatternStory visitor="Signed Out">
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
  </PatternStory>;
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
export const FeedPhone: Story = { globals: phone, render: () => <PreparedLoading layout="feed" />, play: pendingReady };
export const FeedDesktop: Story = { ...FeedPhone, globals: desktop };
export const DetailPhone: Story = { globals: { ...phone, theme: 'dark' }, render: () => <PreparedLoading layout="detail" />, play: pendingReady };
export const DetailDesktop: Story = { ...DetailPhone, globals: { ...desktop, theme: 'light' } };
export const FormPhone: Story = { globals: phone, render: () => <PreparedLoading layout="form" />, play: pendingReady };
export const FormDesktop: Story = { ...FormPhone, globals: desktop };
export const GenericPhone: Story = { globals: { ...phone, theme: 'dark' }, render: () => <PreparedLoading layout="page" />, play: pendingReady };
export const GenericDesktop: Story = { ...GenericPhone, globals: { ...desktop, theme: 'light' } };

function LongRecovery() {
  return <PatternStory visitor="Signed Out"><AppShell>
    <RouteState heading={m.error_heading()} message={Array(4).fill(m.route_error_description()).join(' ')}
      recovery={m.route_retry_later()} />
  </AppShell></PatternStory>;
}
export const LongStringsPhone: Story = {
  globals: { ...phone, locale: 'de', theme: 'dark' }, render: () => <LongRecovery />,
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
export const LongStringsDesktop: Story = { ...LongStringsPhone, globals: { ...desktop, locale: 'de', theme: 'light' } };
