import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { selectManagementStory, organization, human, detailExample } from '../../../../accounts/management/story-api';
import { m } from '../../../../paraglide/messages.js';
import { getLocale } from '../../../../paraglide/runtime.js';
import { AccountManagementPage } from '../../../../accounts/management/pages';
import { PageStory, PatternStory } from '../../../page';
import { ready, reviewParameters } from '../support';
const meta = {
  title: 'Account/Management/Organization',
  id: 'pages-account-management-organization',
  parameters: reviewParameters,
} satisfies Meta;
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

function suppliedHolders(sparse = false) {
  const value = detailExample(organization.id);
  value.members.items = sparse
    ? []
    : [
        {
          accountId: human.id,
          account: { ...human, displayName: 'Alexandria · 読書会 · Cercle de lecture · ' + 'HumanName'.repeat(14) },
          role: 'owner',
        },
        { accountId: '01a1a000-0000-7000-8000-000000000199', account: null, role: 'member' },
      ];
  value.members.next = 'members +/=?& continuation';
  value.responsibilities!.next = 'operators +/=?& continuation';
  return (
    <PatternStory visitor="Signed In" path={`/organizations/${organization.id}`}>
      <div dir="rtl" className="p-4">
        <AccountManagementPage
          page={{ state: 'ready', value, issuer: 'https://auth.example.test', organizationsAvailable: null }}
          cursors={{ organizationsCursor: 'kept-org', operatorsCursor: 'kept-operator', membersCursor: 'kept-member' }}
          retry={() => {}}
        />
      </div>
    </PatternStory>
  );
}
async function holdersGeometry({ canvasElement }: { canvasElement: HTMLElement }) {
  const article = canvasElement.querySelector('article')!;
  await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
  for (const control of article.querySelectorAll<HTMLElement>('a, button')) {
    const bounds = control.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.left).toBeGreaterThanOrEqual(article.getBoundingClientRect().left - 1);
    await expect(bounds.right).toBeLessThanOrEqual(article.getBoundingClientRect().right + 1);
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  }
  const next = article.querySelector<HTMLAnchorElement>('a[rel="next"]')!;
  const query = new URL(next.href).searchParams;
  await expect(query.get('organizationsCursor')).toBe('kept-org');
  await expect(query.get('operatorsCursor')).toBe('kept-operator');
  await expect(query.get('membersCursor')).toBe('members +/=?& continuation');
}
export const LongHoldersPhoneRtl: Story = {
  render: () => suppliedHolders(),
  globals: { locale: 'de' },
  play: async (context) => {
    await holdersGeometry(context);
    const missing = within(context.canvasElement)
      .getAllByRole('heading', { level: 3, name: m.managed_missing_title() })[0]!
      .closest('li')!;
    await expect(within(missing).queryByRole('link')).toBeNull();
    await expect(within(missing).getByText(m.managed_member())).toBeVisible();
  },
};
export const LongHoldersDesktopRtl: Story = {
  ...LongHoldersPhoneRtl,
  globals: { locale: 'de' },
};
export const EmptyCurrentHolderPage: Story = {
  ...LongHoldersPhoneRtl,
  render: () => suppliedHolders(true),
  play: async (context) => {
    await holdersGeometry(context);
    await expect(within(context.canvasElement).getByText(m.managed_no_holders())).toBeVisible();
    await expect(context.canvasElement.querySelector('a[rel="next"]')).toBeVisible();
  },
};
