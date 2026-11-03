import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { parseFilter } from '@rezics/filter';
import { savedRuleReadyId } from '../kernel/fake/collection-rules';
import { storyViewerId } from '../kernel/fake/identities';
import { writeSavedQueryHandoff } from '../library/save-query';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Saved query',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Review, Unsupported and ConflictOrUnknown use the actual routed Library and Collection rule editors in AppShell. Saved uses the local create response only as an illustration; Commerce owns native execution and member results. Review phone390 and desktop1280 with both themes and all launch locales.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const filter = parseFilter({
  and: [{ owner: { presence: true } }, { type: { in: ['schema:Book'] } }],
});

function SeededRulePage() {
  writeSavedQueryHandoff({ viewerId: storyViewerId, filter, sort: 'id' });
  return <PageStory visitor="Signed In" path="/library/rules/new" />;
}

export const Review: Story = {
  render: () => <SeededRulePage />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await expect(await canvas.findByRole('heading', { level: 1, name: m.library_rule_new() })).toBeVisible();
    await expect(canvas.getByDisplayValue('schema:Book')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.library_collection_title() })).toHaveValue('');
    await expect(canvas.getByText(m.library_rule_private())).toBeVisible();
  },
};

export const Saved: Story = {
  render: () => <SeededRulePage />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_collection_title() }), 'Saved reading');
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_create() }));
    await expect(await canvas.findByText(m.library_rule_saved())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_rule_members() })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_rule_edit() })).toBeVisible();
  },
};

export const Unsupported: Story = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['library-collection']}?type=schema%3ABook&f.schema%3Akeywords=wd%3AQ123&q=private`}
    />
  ),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await expect(await within(main).findByText(m.library_saved_query_invalid())).toBeVisible();
    await expect(within(main).queryByRole('link', { name: m.library_saved_query_create() })).toBeNull();
  },
};

export const ConflictOrUnknown: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${savedRuleReadyId}/rule`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await expect(await canvas.findByDisplayValue('schema:Book')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(await canvas.findByText(m.library_rule_uncertain())).toBeVisible();
    await expect(canvas.getByDisplayValue('schema:Book')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(canvas.getByText(m.library_rule_uncertain())).toBeVisible();
  },
};
