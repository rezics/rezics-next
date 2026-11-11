import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { selectManagementStory, human, automation, detailExample } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { AccountManagementPage } from '../../../../accounts/management/pages';
import { PageStory, PatternStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = {
  title: 'Account/Management/Account',
  id: 'pages-account-management-account',
  parameters: reviewParameters,
} satisfies Meta;
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
    await expect(within(context.canvasElement).getByRole('link', { name: m.managed_options() })).toHaveAttribute(
      'href',
      `/${getLocale()}/settings?managedAccount=${encodeURIComponent(human.id)}#account`,
    );
    await expect(within(context.canvasElement).getByText(m.managed_options_guidance())).toBeVisible();
    const canvas = within(context.canvasElement);
    const responsibility = canvas.getByRole('heading', { level: 3, name: automation.displayName }).closest('li')!;
    await expect(responsibility).toHaveRole('listitem');
    await expect(within(responsibility).getByRole('link', { name: automation.displayName })).toHaveAttribute(
      'href',
      `/${getLocale()}/accounts/${automation.id}`,
    );
    await expect(responsibility.querySelector('[data-content-item-slot="state"]')).toHaveTextContent(
      m.managed_current(),
    );
  },
};
export const CurrentOperator: Story = {
  render: () => render('populated'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).getByText(m.managed_transfer_unavailable())).toBeVisible();
    await expect(within(context.canvasElement).queryByRole('link', { name: m.managed_delete_self() })).toBeNull();
    await expect(within(context.canvasElement).getByRole('link', { name: m.managed_options() })).toHaveAttribute(
      'href',
      `/${getLocale()}/settings?managedAccount=${encodeURIComponent(automation.id)}#account`,
    );
    await expect(within(context.canvasElement).getByText(m.managed_options_guidance())).toBeVisible();
  },
};
export const Handleless: Story = { render: () => render('handleless'), play: ready };
export const Denied: Story = {
  render: () => render('denied'),
  play: async (context) => {
    await ready(context);
    await expect(within(context.canvasElement).queryByRole('link', { name: m.managed_options() })).toBeNull();
    await expect(within(context.canvasElement).queryByRole('heading', { level: 3 })).toBeNull();
  },
};
export const Unavailable: Story = { render: () => render('unavailable'), play: ready };
export const Missing: Story = { render: () => render('missing'), play: ready };

const retrySupplied = fn();
function suppliedAccount(unavailableIdentity = false) {
  const value = detailExample(unavailableIdentity ? automation.id : human.id);
  value.account = {
    ...value.account,
    displayName: 'Alexandria · 読書会 · Cercle de lecture · 독서 모임 · ' + 'LongHumanName'.repeat(12),
  };
  if (unavailableIdentity) value.operator = null;
  return (
    <PatternStory visitor="Signed In" path={`/accounts/${value.account.id}`}>
      <div dir="rtl" className="p-4">
        <AccountManagementPage
          page={{ state: 'ready', value, issuer: 'https://auth.example.test', organizationsAvailable: null }}
          retry={retrySupplied}
        />
      </div>
    </PatternStory>
  );
}
async function accountControls({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const article = canvasElement.querySelector('article')!;
  await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
  for (const control of article.querySelectorAll<HTMLElement>('a, button')) {
    const bounds = control.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.left).toBeGreaterThanOrEqual(article.getBoundingClientRect().left - 1);
    await expect(bounds.right).toBeLessThanOrEqual(article.getBoundingClientRect().right + 1);
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    control.focus();
    await expect(control).toHaveFocus();
  }
  const refresh = canvas.getByRole('button', { name: m.managed_refresh() });
  retrySupplied.mockClear();
  refresh.focus();
  await userEvent.keyboard('{Enter}');
  await expect(refresh).toHaveFocus();
  await expect(refresh.matches(':focus-visible')).toBe(true);
  await expect(retrySupplied).toHaveBeenCalledTimes(1);
  await expect(canvas.getByText(m.managed_options_guidance())).toBeVisible();
  await expect(canvas.getByText(m.managed_operation_status())).toBeVisible();
}
export const LongSelfRtl: Story = {
  render: () => suppliedAccount(),
  globals: { locale: 'de' },
  play: accountControls,
};

export const OperatorIdentityUnavailable: Story = {
  ...LongSelfRtl,
  render: () => suppliedAccount(true),
  play: async (context) => {
    await accountControls(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText(m.managed_missing_title())).toBeVisible();
    await expect(canvas.getByText(m.managed_transfer_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.managed_delete_self() })).toBeNull();
  },
};
export const Preparing: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <AccountManagementPage page={{ state: 'preparing' }} retry={retrySupplied} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.managed_preparing_text())).toBeVisible();
    retrySupplied.mockClear();
    await userEvent.click(canvas.getByRole('button', { name: m.managed_refresh() }));
    await expect(retrySupplied).toHaveBeenCalledTimes(1);
  },
};
export const SignedOut: Story = {
  render: () => (
    <PatternStory>
      <AccountManagementPage page={{ state: 'signed-out' }} retry={retrySupplied} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: m.managed_sign_in_title() })).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/accounts`)}`,
    );
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.managed_options() })).toBeNull();
  },
};
