import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { selectManagementStory } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { PageStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = { title: 'Pages/Account/Management/Accounts', parameters: reviewParameters } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function render(mode: Parameters<typeof selectManagementStory>[0]) {
  selectManagementStory(mode);
  return <PageStory visitor="Signed In" path="/accounts" />;
}
export const Current: Story = {
  render: () => render('populated'),
  play: async (context) => {
    await ready(context);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(await main.findByText(m.managed_current())).toBeVisible();
    await expect(await main.findByText(m.managed_reconciling())).toBeVisible();
    await expect(main.getByRole('link', { name: 'Atlas Editors' })).toHaveAttribute(
      'href',
      expect.stringContaining('/organizations/'),
    );
    await expect(main.getByRole('link', { name: m.managed_create_organization() })).toHaveAttribute(
      'href',
      'https://auth.example.test/organizations/new',
    );
  },
};
export const Empty: Story = { render: () => render('empty'), play: ready };
export const Preparing: Story = {
  render: () => render('preparing'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByText(m.managed_preparing_text())).toBeVisible();
    await expect(within(context.canvasElement).queryByText(m.managed_no_organizations())).toBeNull();
  },
};
export const LongNames: Story = { render: () => render('long'), play: ready };
export const Denied: Story = { render: () => render('denied'), play: ready };
export const UnavailableRetry: Story = {
  render: () => render('unavailable'),
  play: async (context) => {
    await ready(context);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(main.getByText(m.managed_unavailable_title())).toBeVisible();
    selectManagementStory('empty');
    await userEvent.click(main.getByRole('button', { name: m.managed_refresh() }));
    await expect(await main.findByText(m.managed_no_organizations())).toBeVisible();
  },
};
