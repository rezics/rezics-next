import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { organization, selectManagementStory } from '../../accounts/management/story-api';
import { m } from '../../paraglide/messages.js';
import { PageStory, pageReady } from '../page';

const meta = {
  title: 'Pages/Account/Settings managed account detail',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({ member = false }: { member?: boolean }) {
  selectManagementStory(member ? 'member' : 'populated');
  return <PageStory visitor="Signed In" path={`/settings?managedAccount=${organization.id}&view=accounts#account`} />;
}

export const Manager: Story = {
  render: () => <Example />,
  globals: { viewport: { value: 'desktop1280' } },
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.managed_current());
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
    const back = canvas.getByRole('link', { name: m.managed_back() });
    await expect(back.getAttribute('href')).toMatch(/\/settings\?view=accounts#account$/);
    await expect(canvas.getByRole('heading', { name: m.settings_heading(), level: 1 })).toBeVisible();
  },
};

export const MemberRestricted: Story = {
  render: () => <Example member />,
  globals: { viewport: { value: 'phone390' } },
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.managed_holders_denied());
    await expect(canvas.getByText(m.settings_managed_responsibilities_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.managed_no_responsibilities())).toBeNull();
  },
};
