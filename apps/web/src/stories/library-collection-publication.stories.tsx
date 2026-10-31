import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionPublicationPageView } from '../library/collection-publication-page';
import { publicationExample, publicationRefusal } from '../kernel/fake/collection-publication';
import type { PublicationInput } from '../library/collection-publication';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Library/Collection publication',
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={`/collections/${publicationExample.address.id}/publish`}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative selection/refusal examples in the existing app shell using recorded subject summaries and supplied page props. No positive publication provider. Ordinary 390/1280 Web review, native publication and promoted-main proof remain pending.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const example = (reason: Parameters<typeof publicationRefusal>[0]) => (
  <CollectionPublicationPageView
    page={publicationExample}
    submit={async () => publicationRefusal(reason)}
    onReload={() => {}}
  />
);

async function publicationCanvas(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('main'));
}

async function chooseAndConfirm(canvasElement: HTMLElement) {
  const canvas = await publicationCanvas(canvasElement);
  const checkboxes = canvas.getAllByRole('checkbox');
  await userEvent.click(checkboxes[0]!);
  await userEvent.click(checkboxes[checkboxes.length - 1]!);
  return canvas;
}

export const SelectedEmpty: Story = {
  render: () => example('unavailable'),
  play: async ({ canvasElement }) => {
    const canvas = await publicationCanvas(canvasElement);
    const publish = canvas.getByRole('button', { name: m.library_publication_publish() });
    await expect(publish).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_publication_confirm_empty() }));
    await expect(publish).toBeEnabled();
    await expect(canvas.queryByText(m.library_publication_no_disclosed())).toBeNull();
  },
};

export const SelectedNonempty: Story = {
  render: () => example('unavailable'),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await expect(canvas.getByText(m.library_publication_count({ count: '1' }))).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeEnabled();
  },
};

export const Denied: Story = {
  render: () => example('denied'),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_publication_denied());
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const Stale: Story = {
  render: () => example('stale'),
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_publication_stale());
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const SourceUnavailable: Story = {
  render: () => (
    <CollectionPublicationPageView
      page={{ ...publicationExample, source: { state: 'unavailable' } }}
      submit={async () => publicationRefusal('unavailable')}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = await publicationCanvas(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_publication_unavailable());
    await expect(canvas.queryByRole('checkbox')).toBeNull();
    await expect(canvas.queryByText(m.library_publication_count({ count: '0' }))).toBeNull();
    await expect(canvas.getByRole('button', { name: m.library_publication_publish() })).toBeDisabled();
  },
};

export const Retry: Story = {
  render: () => {
    let previous: PublicationInput | undefined;
    return (
      <CollectionPublicationPageView
        page={publicationExample}
        submit={async (input) => {
          if (previous) await expect(input).toEqual(previous);
          previous = input;
          return publicationRefusal('unknown');
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = await chooseAndConfirm(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_publish() }));
    await canvas.findByText(m.library_publication_unknown());
    await userEvent.click(canvas.getByRole('button', { name: m.library_publication_retry() }));
    await expect(canvas.getAllByRole('checkbox')[0]!).toBeDisabled();
    await expect(canvas.queryByRole('link', { name: m.library_publication_next() })).toBeNull();
  },
};
