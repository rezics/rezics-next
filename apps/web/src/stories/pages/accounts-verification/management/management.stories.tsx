import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../../../../paraglide/messages.js';
import { PageStory } from '../../../page';
import { PatternStory } from '../../../page';
import { AccountManagementPageView } from '../../../../account-verification/pages';
import { AppShell } from '../../../../shell/shell';
import { viewport } from '../fixtures';

const meta = {
  title: 'Account/Accounts',
  id: 'pages-account-accounts',
  parameters: { layout: 'fullscreen', viewport },
  render: () => <PageStory visitor="Signed In" path="/accounts" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('link', { name: m.av_my_verification() });
    await expect(view.getByRole('link', { name: m.av_review_title() })).toHaveAttribute(
      'href',
      expect.stringContaining('/review/account-verifications'),
    );
  },
};
const statePage = (state: 'loading' | 'denied' | 'unavailable') => (
  <PatternStory visitor="Signed In" path="/accounts">
    <AppShell>
      <AccountManagementPageView page={{ state }} refresh={() => undefined} />
    </AppShell>
  </PatternStory>
);
export const Loading: Story = { render: () => statePage('loading') };
export const Denied: Story = { render: () => statePage('denied') };
export const Unavailable: Story = { render: () => statePage('unavailable') };
