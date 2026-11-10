import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { automation, human, organization, selectManagementStory } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { PageStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = {
  title: 'Account/Management/Accounts',
  id: 'pages-account-management-accounts',
  parameters: reviewParameters,
} satisfies Meta;
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
    const membership = main.getByRole('heading', { level: 3, name: organization.displayName }).closest('li')!;
    await expect(membership).toHaveRole('listitem');
    await expect(within(membership).getByRole('link', { name: organization.displayName })).toHaveAttribute(
      'href',
      `/${getLocale()}/organizations/${organization.id}`,
    );
    await expect(membership.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(
      `@${organization.handle}`,
    );
    await expect(membership.querySelector('[data-content-item-slot="state"]')).toHaveTextContent(m.managed_owner());
    await expect(main.getByRole('heading', { level: 3, name: automation.displayName })).toBeVisible();
    await expect(main.getByRole('link', { name: automation.displayName })).toHaveAttribute(
      'href',
      `/${getLocale()}/accounts/${automation.id}`,
    );
    const missing = main.getByRole('heading', { level: 3, name: m.managed_missing_title() }).closest('li')!;
    await expect(within(missing).queryByRole('link')).toBeNull();
    await expect(missing.querySelector('[data-content-item-slot="state"]')).toHaveTextContent(m.managed_reconciling());
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

// Connected route examples are illustrative responses, not native or visual acceptance evidence.
async function directoryJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  await ready({ canvasElement });
  const main = within(within(canvasElement).getByRole('main'));
  const inspect = async () => {
    const article = canvasElement.querySelector('main article')!;
    await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
    for (const control of article.querySelectorAll<HTMLElement>('a, button')) {
      const bounds = control.getBoundingClientRect();
      await expect(bounds.height).toBeGreaterThanOrEqual(44);
      await expect(bounds.left).toBeGreaterThanOrEqual(article.getBoundingClientRect().left - 1);
      await expect(bounds.right).toBeLessThanOrEqual(article.getBoundingClientRect().right + 1);
      await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    }
  };
  await inspect();
  await userEvent.click(main.getByRole('link', { name: organization.displayName }));
  await expect(await main.findByRole('heading', { level: 2, name: m.managed_holders_title() })).toBeVisible();
  await inspect();
  await expect(main.getByRole('link', { name: m.managed_options() })).toHaveAttribute(
    'href',
    `/${getLocale()}/settings?managedAccount=${organization.id}#account`,
  );
  await userEvent.click(main.getByRole('link', { name: m.managed_back() }));
  await userEvent.click(await main.findByRole('link', { name: human.displayName }));
  await expect(await main.findByRole('link', { name: m.managed_delete_self() })).toBeVisible();
  await expect(main.getByText(m.managed_operation_status())).toBeVisible();
  await inspect();
  await userEvent.click(main.getByRole('link', { name: m.managed_back() }));
  await userEvent.click(await main.findByRole('link', { name: automation.displayName }));
  await expect(await main.findByText(m.managed_transfer_unavailable())).toBeVisible();
  selectManagementStory('unavailable');
  await userEvent.click(main.getByRole('button', { name: m.managed_refresh() }));
  await expect(await main.findByText(m.managed_unavailable_title())).toBeVisible();
  await expect(main.queryByRole('link', { name: m.managed_options() })).toBeNull();
  await inspect();
  selectManagementStory('populated');
  const refresh = main.getByRole('button', { name: m.managed_refresh() });
  await userEvent.keyboard('{Tab}');
  refresh.focus();
  await expect(refresh).toHaveFocus();
  await expect(refresh.matches(':focus-visible')).toBe(true);
  await userEvent.keyboard('{Enter}');
  await expect(await main.findByText(m.managed_transfer_unavailable())).toBeVisible();
}
export const CompleteJourney: Story = {
  render: () => render('populated'),
  globals: { locale: 'de' },
  play: directoryJourney,
};

export const CompleteRtlJourney: Story = {
  ...CompleteJourney,
  render: () => <div dir="rtl">{render('populated')}</div>,
};
