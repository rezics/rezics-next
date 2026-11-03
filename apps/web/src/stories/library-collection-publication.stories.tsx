import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { publicationStoryIds } from '../kernel/fake/collection-publication';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection publication',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual `/collections/$id/publish` PageStory coverage using the existing reader, session and story kernel refusals. Named SelectedEmpty, SelectedNonempty, Denied, Stale, SourceUnavailable and Retry stories enter that route. No positive publication provider. Ordinary 390/1280 Web review, native publication and promoted-main proof remain pending.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function publishRoute(id: string) {
  return <PageStory visitor="Signed In" path={`/collections/${id}/publish`} />;
}

async function publicationCanvas(canvasElement: HTMLElement) {
  await pageReady({ canvasElement });
  const canvas = within(within(canvasElement).getByRole('main'));
  await canvas.findByRole('heading', { name: m.library_publication_heading() });
  await waitFor(() => expect(canvas.queryByText(m.library_publication_loading())).toBeNull());
  return canvas;
}

async function readyPublication(canvasElement: HTMLElement) {
  const canvas = await publicationCanvas(canvasElement);
  await canvas.findByText('Selected reading');
  return canvas;
}

async function chooseAndConfirm(canvasElement: HTMLElement) {
  const canvas = await readyPublication(canvasElement);
  const checkboxes = canvas.getAllByRole('checkbox');
  await userEvent.click(checkboxes[0]!);
  await userEvent.click(checkboxes[checkboxes.length - 1]!);
  return canvas;
}

export const SelectedEmpty: Story = {
  render: () => publishRoute(publicationStoryIds.ready),
  play: async ({ canvasElement }) => {
    const canvas = await readyPublication(canvasElement);
    const publish = canvas.getByRole('button', { name: m.library_publication_publish() });
    const zero =
      new Intl.PluralRules(getLocale()).select(0) === 'one'
        ? m.library_publication_count_one({ count: '0' })
        : m.library_publication_count({ count: '0' });
    await expect(canvas.getByText(zero)).toBeVisible();
    const confirmation = canvas.getByRole('checkbox', { name: m.library_publication_confirm_empty() });
    const decision = within(confirmation.closest('[role="group"]') as HTMLElement);
    await expect(decision.getByText(m.library_publication_page_only())).toBeVisible();
    await expect(decision.getByText(m.library_publication_previous())).toBeVisible();
    await expect(decision.getByText(m.library_publication_privacy())).toBeVisible();
    await expect(canvas.queryByRole('region', { name: m.library_publication_output() })).toBeNull();
    await expect(publish).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_publication_confirm_empty() }));
    await expect(publish).toBeEnabled();
    await expect(canvas.queryByText(m.library_publication_no_disclosed())).toBeNull();
  },
};

export const SelectedNonempty: Story = {
  render: () => publishRoute(publicationStoryIds.ready),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await expect(canvas.getByText(m.library_publication_count_one({ count: '1' }))).toBeVisible();
    await expect(
      canvas.getByRole('checkbox', { name: m.library_publication_confirm_one({ count: '1' }) }),
    ).toBeChecked();
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeEnabled();
    const details = canvas.getByText(m.library_publication_details()).closest('details')!;
    await expect(details).not.toHaveAttribute('open');
    await expect(canvas.getByText(m.library_publication_canonical())).not.toBeVisible();
    await userEvent.click(within(details).getByText(m.library_publication_details()));
    await expect(canvas.getByText(m.library_publication_canonical())).toBeVisible();
    await expect(canvas.getByText(m.library_publication_description())).toBeVisible();
    await userEvent.click(canvas.getAllByRole('checkbox')[1]!);
    await expect(canvas.getByText(m.library_publication_count({ count: '2' }))).toBeVisible();
    const confirmation = canvas.getByRole('checkbox', { name: m.library_publication_confirm({ count: '2' }) });
    await expect(confirmation).not.toBeChecked();
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
    await userEvent.click(confirmation);
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeEnabled();
  },
};

export const Denied: Story = {
  render: () => publishRoute(publicationStoryIds.denied),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_publication_denied());
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const Stale: Story = {
  render: () => publishRoute(publicationStoryIds.stale),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_publication_stale());
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const SourceUnavailable: Story = {
  render: () => publishRoute(publicationStoryIds.unavailable),
  play: async ({ canvasElement }) => {
    const canvas = await publicationCanvas(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_publication_unavailable());
    await expect(canvas.queryByRole('checkbox')).toBeNull();
    await expect(canvas.queryByText(m.library_publication_count({ count: '0' }))).toBeNull();
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const Retry: Story = {
  render: () => publishRoute(publicationStoryIds.retry),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await canvas.findByText(m.library_publication_unknown());
    const retry = canvas.getByRole('button', { name: m.library_publication_retry() });
    const decision = within(retry.closest('[role="group"]') as HTMLElement);
    await expect(decision.getByRole('alert')).toHaveTextContent(m.library_publication_unknown());
    await expect(decision.getByText(m.library_publication_previous())).toBeVisible();
    await expect(decision.getByText(m.library_publication_privacy())).toBeVisible();
    await expect(canvas.queryByRole('region', { name: m.library_publication_output() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_retry() }));
    await expect(canvas.getAllByRole('checkbox')[0]!).toBeDisabled();
    await expect(canvas.queryByRole('link', { name: m.library_publication_next() })).toBeNull();
  },
};
