import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { selectShellErrorStory, shellErrorOfferId, shellErrorReads } from '../kernel/fake/shell-errors';
import offer from '../kernel/recorded/offer.json';
import { PageStory } from './page';

const meta = { title: 'Pages/Shell/Errors', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ErrorStory({ outcome }: { outcome: Parameters<typeof selectShellErrorStory>[0] }) {
  const locale = getLocale();
  useMemo(() => selectShellErrorStory(outcome), [outcome, locale]);
  return <PageStory key={`${outcome}:${locale}`} visitor="Signed Out" path={`/offers/${shellErrorOfferId}`} />;
}

async function errorReady({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const main = within(await view.findByRole('main'));
  await main.findByRole('heading', { name: m.error_heading() });
  await expect(view.getAllByRole('main')).toHaveLength(1);
  await expect(main.getByRole('link', { name: m.status_home() })).toHaveAttribute('href', `/${getLocale()}`);
  await expect(main.getByRole('link', { name: m.status_search() })).toHaveAttribute('href', `/${getLocale()}/search`);
  await expect(shellErrorReads()).toBe(1);
  return main;
}

export const Unavailable: Story = {
  render: () => <ErrorStory outcome="unavailable" />,
  play: async (context) => {
    const main = await errorReady(context);
    const retry = await main.findByRole('button', { name: m.status_retry() });
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    await waitFor(() => expect(shellErrorReads()).toBe(2), { timeout: 5_000 });
    await expect(await main.findByRole('heading', { name: offer.offer.title })).toBeVisible();
    await expect(main.queryByRole('heading', { name: m.error_heading() })).toBeNull();
  },
};
export const StillUnavailable: Story = {
  render: () => <ErrorStory outcome="still-unavailable" />,
  play: async (context) => {
    const main = await errorReady(context);
    await userEvent.click(main.getByRole('button', { name: m.status_retry() }));
    await waitFor(() => expect(shellErrorReads()).toBe(2));
    await expect(await main.findByRole('button', { name: m.status_retry() })).toBeEnabled();
    await expect(main.getByRole('heading', { name: m.error_heading() })).toBeVisible();
    await expect(main.queryByText(offer.offer.title)).toBeNull();
  },
};
export const Closed: Story = {
  render: () => <ErrorStory outcome="closed" />,
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole('main'));
    await main.findByRole('heading', { name: m.platform_closed_heading() });
    await expect(main.queryByRole('button', { name: m.status_retry() })).toBeNull();
  },
};
export const NotFound: Story = {
  render: () => <ErrorStory outcome="missing" />,
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole('main'));
    await main.findByRole('heading', { name: m.not_found_heading() });
    await expect(main.queryByRole('button', { name: m.status_retry() })).toBeNull();
  },
};
