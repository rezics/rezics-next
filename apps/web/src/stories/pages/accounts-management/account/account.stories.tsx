import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { selectManagementStory, human, automation } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { PageStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = { title: 'Pages/Account/Management/Account', parameters: reviewParameters } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function render(mode: Parameters<typeof selectManagementStory>[0], self = false) {
  selectManagementStory(mode);
  return <PageStory visitor="Signed In" path={`/accounts/${self ? human.id : automation.id}`} />;
}
export const OwnAccount: Story = {
  render: () => render('populated', true),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByRole('link', { name: m.managed_delete_self() })).toHaveAttribute(
      'href',
      'https://auth.example.test/account/delete',
    );
  },
};
export const CurrentOperator: Story = {
  render: () => render('populated'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByText(m.managed_transfer_unavailable())).toBeVisible();
    await expect(within(context.canvasElement).queryByRole('link', { name: m.managed_delete_self() })).toBeNull();
  },
};
export const Handleless: Story = { render: () => render('handleless'), play: ready };
export const Denied: Story = { render: () => render('denied'), play: ready };
export const Unavailable: Story = { render: () => render('unavailable'), play: ready };
export const Missing: Story = { render: () => render('missing'), play: ready };
