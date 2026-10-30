import type { Meta, StoryObj } from '@storybook/react-vite';
import { CollectionRuleEditor } from '../library/collection-rule-editor';
import { unavailableRuleChoices, type RulePage } from '../library/collection-rule-read';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection rule',
  parameters: {
    layout: 'fullscreen',
    admitted: ['collection.create', 'collection_rule.get', 'collection_rule.update'],
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
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
export const Draft390: Story = {
  render: () => <UnavailableDraft />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const Draft1280: Story = { render: () => <UnavailableDraft /> };
export const ActualCreate390: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/rules/new" />,
  play: pageReady,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const ActualCreate1280: Story = {
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
