import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { fictionModules, fictionZone } from '../zones/fixtures.ts';
import type { JoinOutcome, MembershipActions } from './membership.tsx';
import type { JoinPolicy, Membership } from './membership-state.ts';
import { RealmPageStory } from './story-page.tsx';

type Case = 'signed-out' | 'open' | 'invitation' | 'joined' | 'changed-terms' | 'closed-by-now';

const policy = (overrides: Partial<JoinPolicy> = {}): JoinPolicy => ({ policyRevision: '3', termsRevision: 'rules-7',
  selfJoin: true, open: true, membershipGeneration: '0', state: 'absent', ...overrides });

const initial: Record<Case, Membership | null> = {
  'signed-out': null,
  open: { policy: policy(), following: false, followRevision: null },
  invitation: { policy: policy({ selfJoin: false }), following: false, followRevision: null },
  joined: { policy: policy({ state: 'joined', membershipGeneration: '1' }), following: true, followRevision: 'r1' },
  'changed-terms': { policy: policy(), following: false, followRevision: null },
  'closed-by-now': { policy: policy(), following: false, followRevision: null },
};

/** Main in memory: joining answers as the case says, follows always save. */
function actions(which: Case): MembershipActions {
  if (which === 'signed-out') return { kind: 'signed-out', signInHref: '/auth/start?returnTo=%2Fen%2Fr%2Ffiction' };
  let revision = 0;
  let current = initial[which]!;
  const outcome: JoinOutcome = which === 'changed-terms' ? { kind: 'stale' }
    : which === 'closed-by-now' ? { kind: 'denied' } : { kind: 'joined' };
  return {
    kind: 'ready',
    join: async () => { if (outcome.kind === 'joined') current = { ...current, policy: policy({ state: 'joined', membershipGeneration: '1' }),
      following: true, followRevision: 'r1', level: 'highlights', source: 'join' }; return outcome; },
    follow: async following => { current = { ...current, following, followRevision: `r${++revision}` };
      return { kind: 'saved', following, revision: current.followRevision! }; },
    refresh: async () => which === 'changed-terms' ? { ...current, policy: policy({ termsRevision: 'rules-8' }) } : current,
  };
}

function Page({ which, locale }: { which: Case; locale: UiLocale }) {
  return <RealmPageStory zone={fictionZone(locale)} modules={fictionModules(locale).slice(0, 2)} locale={locale}
    members={locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members'} membership={initial[which]}
    membershipActions={actions(which)} />;
}

const meta = {
  title: 'Realm/Join and follow',
  component: Page,
  args: { which: 'open', locale: 'en' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community'), 'en') } },
  render: (args, { globals }) => <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
  async afterEach(context) {
    if (import.meta.env.VITE_G944_CAPTURE !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-944/screenshots/${context.id}.png` });
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A first visit: Join leads to sign-in and back to this community. */
export const SignedOut: Story = {
  args: { which: 'signed-out' },
  async play({ canvasElement }) {
    const join = within(canvasElement).getByRole('link', { name: /Join.*Sign in/ });
    await expect(join).toHaveAttribute('href', '/auth/start?returnTo=%2Fen%2Fr%2Ffiction');
  },
};

/** Joining asks for consent to the rules and leaves the member list opt-in; it then follows into Home. */
export const JoinOnYourOwn: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    const dialog = within(await waitFor(() => within(document.body).getByRole('dialog')));
    // The dialog fades in; wait for its title rather than catching it mid-animation.
    await waitFor(() => expect(dialog.getByRole('heading', { name: 'Join Fiction 小说' })).toBeVisible());
    await expect(dialog.getByRole('link', { name: 'Read the community rules' })).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'community', ['about']), 'en'));
    const listed = dialog.getByRole('checkbox', { name: /Show me on the public member list/ });
    await expect(listed).not.toBeChecked();
    await userEvent.click(listed);
    await userEvent.click(dialog.getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    const joined = await canvas.findByRole('button', { name: /Joined/ });
    // The follow that joining starts must not bring back the offer to join.
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(canvas.queryByRole('button', { name: /^Join(?: · Fiction 小说)?$/ })).toBeNull();
    await expect(joined).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Notifications: Highlights' })).toBeVisible();
  },
};

export const JoinChinese: Story = { globals: { locale: 'zh-Hans' } };
export const JoinPhone: Story = { globals: { viewport: { value: 'phone' } } };

/** Joining is by invitation: the reader can still follow the community into Home. */
export const FollowOnly: Story = {
  args: { which: 'invitation' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: /^Join(?: · Fiction 小说)?$/ })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Fiction 小说' }));
    await expect(await canvas.findByRole('button', { name: 'Following · Fiction 小说 · Unfollow' })).toBeVisible();
  },
};

/** A member sees that they joined; their Home follow is in the menu. */
export const Joined: Story = {
  args: { which: 'joined' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /Joined/ })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Relationship options · Fiction 小说' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitem', { name: 'Unfollow' })).toBeVisible());
  },
};

export const JoinedDark: Story = { args: { which: 'joined' }, globals: { theme: 'dark' } };

/** The terms changed while the dialog was open: say so, and join again on the new terms. */
export const TermsChanged: Story = {
  args: { which: 'changed-terms' },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    const dialog = within(await waitFor(() => within(document.body).getByRole('dialog')));
    await userEvent.click(dialog.getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('changed how people join');
  },
};

export const NoLongerOpen: Story = {
  args: { which: 'closed-by-now' },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    const dialog = within(await waitFor(() => within(document.body).getByRole('dialog')));
    await userEvent.click(dialog.getByRole('button', { name: /^Join(?: · Fiction 小说)?$/ }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('You can’t join this community.');
  },
};
