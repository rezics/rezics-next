import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DynamicCollectionPage } from '../library/dynamic-collection-page';
import type { DynamicCollectionPage as Page } from '../library/dynamic-collection';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Saved query results',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN illustrative routed saved-query states on the existing Dynamic Collection reader. Native execution, publication, browser and visual acceptance remain controller obligations. Review phone390/desktop1280 with locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const recovered: Page = {
  id: 'saved /%二?&',
  title: 'Saved query',
  description: null,
  curator: null,
  curatorAccountId: 'story-viewer',
  members: [
    {
      subject: {
        id: 'saved-subject',
        type: 'schema:Book',
        types: ['schema:Book'],
        label: 'The Long Way to a Small, Quiet Library',
        cover: null,
      },
    },
  ],
  cursor: ' expired/+==?f.=old&cursor=other#二% ',
  next: ' native-next/+==?f.=next ',
  preparing: false,
  unavailable: false,
  retryAfterMs: 1000,
  cursorRestarted: true,
};

export const OwnerReady: Story = {
  name: 'Owner, current unique-subject results',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Saved query' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'The Long Way to a Small, Quiet Library' })).toBeVisible();
    const edit = canvas.getByRole('link', { name: m.library_rule_edit() });
    await expect(edit).toBeVisible();
    await expect(edit).toHaveAttribute('href', expect.stringMatching(/\/collections\/dynamic-saved\/rule$/));
    edit.focus();
    await expect(edit).toHaveFocus();
    await expect(canvas.queryByText(m.library_collection_builtin_rule())).toBeNull();
  },
  render: () => <PageStory visitor="Signed In" path="/collections/dynamic-saved" />,
};

export const Empty: Story = {
  name: 'Public, genuine empty 200',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_collection_empty())).toBeVisible();
    await expect(canvas.queryByText(m.library_dynamic_preparing())).toBeNull();
    await expect(canvas.queryByText(m.library_dynamic_unavailable())).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.library_rule_edit() })).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/collections/dynamic-saved-empty" />,
};

export const Preparing: Story = {
  name: 'Public, 202 preparing',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_preparing())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/collections/dynamic-saved-preparing" />,
};

export const Denied: Story = {
  name: 'Signed out, private saved identity concealed',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.not_found_heading() })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.library_rule_edit() })).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/collections/dynamic-saved-private" />,
};

export const Unavailable: Story = {
  name: 'Public, 503 unavailable',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/collections/dynamic-saved-unavailable" />,
};

export const Recovery: Story = {
  name: 'Invalidated cursor restart',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_collections_cursor_reset())).toBeVisible();
    const first = canvas.getByRole('link', { name: m.library_dynamic_page_reader_first_page() });
    await expect(first).toBeVisible();
    first.focus();
    await expect(first).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: m.library_collection_more() })).toHaveFocus();
    await expect(canvas.getByRole('link', { name: 'The Long Way to a Small, Quiet Library' })).toBeVisible();
  },
  render: () => (
    <PatternStory path={`/collections/${encodeURIComponent(recovered.id)}`}>
      <main className="mx-auto w-full min-w-0 max-w-4xl p-4">
        <DynamicCollectionPage
          page={recovered}
          search={{ type: 'schema:Book', 'f.schema:keywords': 'concept-b' }}
        />
      </main>
    </PatternStory>
  ),
};
