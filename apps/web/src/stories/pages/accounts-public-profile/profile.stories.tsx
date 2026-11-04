import { defaultReader } from '../../../subject/reader';
import type { ProfileReading } from '../../../accounts/public-profile/reader-presentation/adapter';
import preferences from '../../../kernel/recorded/settings-preferences.json';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PublicProfilePage } from '../../../accounts/public-profile/page';
import { PublicAccountState } from '../../../accounts/public-profile/view';
import { subjectPageMessages, viewTabLabels } from '../../../features/pages/route-support';
import { subjectTabs } from '../../../features/pages/views';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { AppShell } from '../../../shell/shell';
import { PatternStory, PageStory, pageReady } from '../../page';
import { profilePage } from './fixtures';

const longName = '世界各地的讀者與翻譯者共同維護的獨立閱讀室'.repeat(200).slice(0, 4096);
const longHandle = 'international-reading-room'.padEnd(64, 'x');
const longBio = 'Readers and librarians share reading notes across languages.\n閱讀筆記與翻譯持續更新。\n'
  .repeat(64)
  .slice(0, 4096);

function Example({
  readingState,
  mode = 'human',
}: {
  readingState?: 'conservative' | 'loading' | 'ready';
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
            displayName: longName,
            handle: longHandle,
            bio: longBio,
            links: Array.from({ length: 5 }, (_, index) => ({
              label: `${'閱讀紀錄與翻譯'.repeat(10).slice(0, 63)}${index + 1}`,
              url: `https://example.test/journal/${index + 1}`.padEnd(2048, 'x'),
            })),
          },
        }
      : {}),
    empty: mode === 'empty',
    ...(mode === 'denied' ? { activityStatus: 403 } : {}),
  });
  if (mode === 'long' && page.account) page.account = { ...page.account, handle: longHandle };
  const locale = getLocale();
  return (
    <PatternStory visitor="Signed Out" path={`/@${page.account!.handle}`}>
      <AppShell>
        <PublicProfilePage
          page={page}
          {...(readingState ? { reading: {
            state: readingState,
            response: readingState,
            reader: readingState === 'ready'
              ? { spoilerLevel: preferences.spoilerLevel, suitability: preferences.suitability }
              : defaultReader,
            ...(readingState !== 'conservative' ? { retry: () => {} } : {}),
          } as ProfileReading } : {})}
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
      </AppShell>
    </PatternStory>
  );
}

async function profileShellReady(canvasElement: HTMLElement, heading: string = m.public_account_heading()) {
  const canvas = within(canvasElement);
  const main = await canvas.findByRole('main');
  await expect(canvas.getAllByRole('main')).toHaveLength(1);
  const view = within(main);
  await expect(view.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  return view;
}

const meta = {
  title: 'Pages/Account/Public profile',
  id: 'pages-accounts-public-profile',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Human: Story = {
  render: () => <PageStory visitor="Signed Out" path="/@mira" />,
  play: async (context) => {
    await pageReady(context);
    await profileShellReady(context.canvasElement, 'Mira Okabe');
  },
};
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
    await profileShellReady(canvasElement, 'Reading Assistant');
    await expect(within(canvasElement).getByText(m.public_account_automated())).toBeVisible();
    await expect(canvasElement.querySelector('a[href$="/@"]')).toBeNull();
  },
};
export const HandlelessOperator: Story = {
  render: () => <Example mode="operator" />,
  play: async ({ canvasElement }) => {
    await profileShellReady(canvasElement, 'Reading Assistant');
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
export const LongContent: Story = {
  render: () => <Example mode="long" />,
  play: async ({ canvasElement }) => {
    await profileShellReady(canvasElement, longName);
    const card = canvasElement.querySelector<HTMLElement>('[data-slot="agent-profile-card"]')!;
    const description = card.querySelector<HTMLElement>('[data-slot="agent-description"]')!;
    const heading = within(card).getByRole('heading', { level: 1, name: longName });
    await expect(heading).toHaveClass('font-sans');
    await expect(within(description).getByText(longBio, { normalizer: (text) => text })).toBeVisible();
    await expect(within(description).getAllByRole('link')).toHaveLength(5);
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    if (window.matchMedia('(max-width: 639px)').matches) {
      const content = description.getBoundingClientRect();
      const name = heading.getBoundingClientRect();
      await expect(content.left).toBeLessThan(name.left);
      await expect(content.width).toBeGreaterThan(name.width);
      await expect(content.top).toBeGreaterThanOrEqual(name.bottom);
    }
  },
};
export const EmptyActivity: Story = { render: () => <Example mode="empty" /> };
export const DeniedActivity: Story = { render: () => <Example mode="denied" /> };
export const Preparing: Story = {
  render: () => (
    <PatternStory visitor="Signed Out" path="/@mira">
      <AppShell>
        <PublicAccountState page state="preparing" retry={() => {}} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = await profileShellReady(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.public_account_preparing());
  },
};
export const Denied: Story = {
  render: () => (
    <PatternStory visitor="Signed Out" path="/@mira">
      <AppShell>
        <PublicAccountState page state="denied" />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = await profileShellReady(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.public_account_denied());
  },
};
export const Unavailable: Story = {
  render: () => (
    <PatternStory visitor="Signed Out" path="/@mira">
      <AppShell>
        <PublicAccountState page state="unavailable" retry={() => {}} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = await profileShellReady(canvasElement);
    await expect(view.getByRole('alert')).toHaveTextContent(m.public_account_unavailable());
  },
};

export const ConservativeReading: Story = { render: () => <Example readingState="conservative" /> };
export const RecoveringReading: Story = { render: () => <Example readingState="loading" /> };
export const AdmittedReading: Story = { render: () => <Example readingState="ready" /> };
