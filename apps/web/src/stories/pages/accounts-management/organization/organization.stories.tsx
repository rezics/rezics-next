import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { selectManagementStory, organization, human } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { PageStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = { title: 'Pages/Account/Management/Organization', parameters: reviewParameters } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function render(mode: Parameters<typeof selectManagementStory>[0]) {
  selectManagementStory(mode);
  return <PageStory visitor="Signed In" path={`/organizations/${organization.id}`} />;
}
export const Owner: Story = {
  render: () => render('populated'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByRole('heading', { name: m.managed_holders_title() })).toBeVisible();
    await expect(within(context.canvasElement).getByRole('link', { name: m.managed_options() })).toHaveAttribute(
      'href',
      `/${getLocale()}/settings?managedAccount=${encodeURIComponent(organization.id)}#account`,
    );
    await expect(within(context.canvasElement).getByText(m.managed_options_guidance())).toBeVisible();
    const holder = within(context.canvasElement)
      .getByRole('heading', { level: 3, name: human.displayName })
      .closest('li')!;
    await expect(holder).toHaveRole('listitem');
    await expect(within(holder).getByRole('link', { name: human.displayName })).toHaveAttribute(
      'href',
      `/${getLocale()}/@${human.handle}`,
    );
    await expect(holder.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(`@${human.handle}`);
    await expect(holder.querySelector('[data-content-item-slot="state"]')).toHaveTextContent(m.managed_owner());
  },
};
export const Member: Story = {
  render: () => render('member'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByText(m.managed_holders_denied())).toBeVisible();
    await expect(within(context.canvasElement).queryByRole('heading', { name: m.managed_operated_title() })).toBeNull();
    await expect(
      within(context.canvasElement).queryByRole('heading', { level: 3, name: human.displayName }),
    ).toBeNull();
    await expect(within(context.canvasElement).queryByRole('link', { name: human.displayName })).toBeNull();
    await expect(within(context.canvasElement).getByRole('link', { name: m.managed_options() })).toHaveAttribute(
      'href',
      `/${getLocale()}/settings?managedAccount=${encodeURIComponent(organization.id)}#account`,
    );
    await expect(within(context.canvasElement).getByText(m.managed_options_guidance())).toBeVisible();
  },
};
export const LongNames: Story = { render: () => render('long'), play: ready };
export const Empty: Story = { render: () => render('empty'), play: ready };
export const Denied: Story = {
  render: () => render('denied'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).queryByRole('link', { name: m.managed_options() })).toBeNull();
  },
};
export const Unavailable: Story = { render: () => render('unavailable'), play: ready };
