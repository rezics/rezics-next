import type { Meta, StoryObj } from '@storybook/react-vite';
import { CollectionRuleEditor } from '../library/collection-rule-editor';
import { unavailableRuleChoices, type RulePage } from '../library/collection-rule-read';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection rule',
  parameters: {
    layout: 'fullscreen',
    admitted: ['collection.create', 'collection_rule.get', 'collection_rule.update'],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const draft: RulePage = {
  state: 'new',
  choices: unavailableRuleChoices(),
  intent: '10000000-0000-4000-8000-000000000001',
};
function UnavailableDraft() {
  return (
    <CollectionRuleEditor
      page={draft}
      csrfToken=""
      save={async () => ({ ok: false, reason: 'unavailable' })}
      reload={async () => draft}
    />
  );
}
export const Draft: Story = {
  render: () => <UnavailableDraft />,
};
export const ActualCreate: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/rules/new" />,
  play: pageReady,
};
export const PrivateUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/collections/saved-rule-unavailable/rule" />,
  play: pageReady,
};
export const Denied: Story = {
  render: () => (
    <CollectionRuleEditor
      page={{ state: 'denied' }}
      csrfToken=""
      save={async () => ({ ok: false, reason: 'forbidden' })}
      reload={async () => ({ state: 'denied' })}
    />
  ),
};
