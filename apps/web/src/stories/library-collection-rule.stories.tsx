import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { savedRuleReadyId, savedRuleUnavailableId } from '../kernel/fake/collection-rules';
import active from '../kernel/recorded/definitions-active.json';
import { CollectionRuleEditor } from '../library/collection-rule-editor';
import { unavailableRuleChoices, type RulePage } from '../library/collection-rule-read';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection rule',
  parameters: {
    layout: 'fullscreen',
    admitted: ['collections', 'collection.create', 'collection_rule.get', 'collection_rule.update'],
    docs: {
      description: {
        component:
          'Source states for Collection review: Draft, ActualCreate, ActualReady, PrivateUnavailable, Denied. Draft and Denied are supplied PatternStory editor states in the existing app shell. ActualCreate, ActualReady and PrivateUnavailable enter the generated /library/rules/new and /collections/$id/rule routes using the current recorded preview at kernel.local. ActualCreate shows title validation. ActualReady loads the delivered GET rule schema with recorded release choices; PUT and member execution stay unavailable in this preview. Canonical Storybook IDs are unconfirmed until an admitted index. These illustrative stories do not establish native execution, authorization, visual review or promoted-main proof.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const draft: RulePage = {
  state: 'new',
  viewerId: 'story-viewer',
  choices: unavailableRuleChoices(),
  intent: '10000000-0000-4000-8000-000000000001',
};
function UnavailableDraft() {
  return (
    <CollectionRuleEditor
      page={draft}
      viewerId="story-viewer"
      collectionId={null}
      admitted={['collection.create']}
      csrfToken="story-csrf-token"
      save={async () => ({ ok: false, reason: 'unavailable' })}
      reload={async () => draft}
    />
  );
}
export const Draft: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/library/rules/new">
      <AppShell>
        <UnavailableDraft />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(await within(canvasElement).findByRole('main'));
    await expect(canvas.getByRole('heading', { level: 1, name: m.library_rule_new() })).toBeVisible();
    await expect(canvas.getByText(m.condition_metadata_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.library_rule_labels_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.library_rule_members() })).toBeNull();
  },
};
export const ActualCreate: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/rules/new" />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await expect(await canvas.findByRole('heading', { level: 1, name: m.library_rule_new() })).toBeVisible();
    await expect(canvas.getByText(m.library_rule_labels_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.condition_metadata_unavailable())).toBeNull();
    const title = canvas.getByRole('textbox', { name: m.library_collection_title() });
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_create() }));
    await expect(title).toBeInvalid();
    await expect(canvas.queryByRole('link', { name: m.library_rule_members() })).toBeNull();
  },
};
export const ActualReady: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${savedRuleReadyId}/rule`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await expect(await canvas.findByRole('heading', { level: 1, name: m.library_rule_edit() })).toBeVisible();
    await expect(main.querySelector('form')).not.toBeNull();
    await expect(canvas.getByText(m.library_rule_presence())).toBeVisible();
    await expect(canvas.getByDisplayValue('schema:Book')).toBeVisible();
    await expect(canvas.getByText(m.library_rule_labels_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.library_rule_denied())).toBeNull();
    await expect(canvas.queryByText(m.library_rule_unavailable())).toBeNull();
    await expect(canvas.getByRole('link', { name: m.library_rule_members() })).toBeVisible();
    await userEvent.click(canvas.getByText(`${m.catalogue_technical_details()} · ${m.library_rule_details()}`));
    await expect(canvas.getByText(active.digest)).toBeVisible();
  },
};
export const PrivateUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${savedRuleUnavailableId}/rule`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const canvas = within(main);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_rule_unavailable());
    await expect(canvas.getByText(m.library_rule_unavailable())).toBeVisible();
    await expect(main.querySelector('form, input, select, textarea')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.library_rule_members() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_retry() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_rule_unavailable());
    await expect(main.querySelector('form, input, select, textarea')).toBeNull();
  },
};
export const Denied: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path={`/collections/${savedRuleUnavailableId}/rule`}>
      <AppShell>
        <CollectionRuleEditor
          page={{ state: 'denied' }}
          viewerId="story-viewer"
          collectionId={savedRuleUnavailableId}
          admitted={['collection_rule.get', 'collection_rule.update']}
          csrfToken="story-csrf-token"
          save={async () => ({ ok: false, reason: 'forbidden' })}
          reload={async () => ({ state: 'denied' })}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const main = await within(canvasElement).findByRole('main');
    const canvas = within(main);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_rule_denied());
    await expect(canvas.getByText(m.library_rule_denied())).toBeVisible();
    await expect(main.querySelector('form, input, select, textarea')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.library_rule_members() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_retry() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_rule_denied());
    await expect(main.querySelector('form, input, select, textarea')).toBeNull();
  },
};
