import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PublicProfilePage } from '../../../accounts/public-profile/page';
import { PublicAccountState } from '../../../accounts/public-profile/view';
import { subjectPageMessages, viewTabLabels } from '../../../features/pages/route-support';
import { subjectTabs } from '../../../features/pages/views';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { PatternStory, PageStory, pageReady } from '../../page';
import { profilePage } from './fixtures';

function Example({
  mode = 'human',
}: {
  mode?: 'human' | 'verified' | 'organization' | 'automated' | 'operator' | 'private' | 'empty' | 'denied' | 'long';
}) {
  const page = profilePage({
    verified: mode === 'verified' || mode === 'organization',
    ...(mode === 'organization' ? { profile: { kind: 'organization', displayName: 'Lantern Press' } } : {}),
    ...(mode === 'automated' || mode === 'operator'
      ? { profile: { automated: true, operatorId: 'public-operator', displayName: 'Reading Assistant' } }
      : {}),
    ...(mode === 'private'
      ? { profile: { publicViews: { posts: false, reviews: false, collections: false, realms: false } } }
      : {}),
    ...(mode === 'long'
      ? {
          profile: {
            displayName: 'The International Reading Room and Translation Collective',
            bio: 'Readers, translators and librarians meet here to exchange notes across languages.\nWe keep our reading lists public so others can join the conversation.',
            links: [{ label: 'Reading journal and upcoming conversations', url: 'https://example.test/journal' }],
          },
        }
      : {}),
    empty: mode === 'empty',
    ...(mode === 'denied' ? { activityStatus: 403 } : {}),
  });
  const locale = getLocale();
  return (
    <PatternStory>
      <PublicProfilePage
        page={page}
        locale={locale}
        messages={subjectPageMessages()}
        tabs={subjectTabs(page)}
        tabLabels={viewTabLabels()}
        base={`/${locale}/@${page.account!.handle}`}
        {...(mode === 'operator'
          ? { operator: { id: 'public-operator', handle: null, displayName: 'Reading Room' } }
          : {})}
        publicRealms={mode !== 'private'}
        renderJsonLd={false}
      />
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Accounts/Public profile',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Human: Story = { render: () => <PageStory visitor="Signed Out" path="/@mira" />, play: pageReady };
export const SignedIn: Story = { render: () => <PageStory visitor="Signed In" path="/@mira" />, play: pageReady };
export const Verified: Story = {
  render: () => <Example mode="verified" />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="agent-verified"] a')).toBeTruthy();
    const link = within(canvasElement).getByRole('link', { name: m.public_account_realms() });
    link.focus();
    await expect(link).toHaveFocus();
    await userEvent.tab();
  },
};
export const Organization: Story = { render: () => <Example mode="organization" /> };
export const Automated: Story = {
  render: () => <Example mode="automated" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.public_account_automated())).toBeVisible();
    await expect(canvasElement.querySelector('a[href$="/@"]')).toBeNull();
  },
};
export const HandlelessOperator: Story = {
  render: () => <Example mode="operator" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Reading Room')).toBeVisible();
    await expect(canvasElement.querySelector('a[href$="/@"]')).toBeNull();
  },
};
export const PrivateActivity: Story = {
  render: () => <Example mode="private" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('link', { name: m.public_account_realms() })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="account-posts"]')).toBeNull();
  },
};
export const LongContent: Story = { render: () => <Example mode="long" /> };
export const EmptyActivity: Story = { render: () => <Example mode="empty" /> };
export const DeniedActivity: Story = { render: () => <Example mode="denied" /> };
export const Preparing: Story = {
  render: () => (
    <PatternStory>
      <PublicAccountState page state="preparing" retry={() => {}} />
    </PatternStory>
  ),
};
export const Denied: Story = {
  render: () => (
    <PatternStory>
      <PublicAccountState page state="denied" />
    </PatternStory>
  ),
};
export const Unavailable: Story = {
  render: () => (
    <PatternStory>
      <PublicAccountState page state="unavailable" retry={() => {}} />
    </PatternStory>
  ),
};
