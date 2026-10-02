import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { AppShell } from '../shell/app-shell.tsx';
import { CommunityNav } from '../shell/community-nav.tsx';
import type { CommunityNavigation } from '../shell/communities.ts';
import { messages as shell } from '../shell/messages.ts';
import shellDe from '../shell/messages/de.ts';
import shellEs from '../shell/messages/es.ts';
import shellFr from '../shell/messages/fr.ts';
import shellJa from '../shell/messages/ja.ts';
import shellKo from '../shell/messages/ko.ts';
import shellHans from '../shell/messages/zh-Hans.ts';
import shellHant from '../shell/messages/zh-Hant.ts';
import { RelationshipControl } from './control.tsx';
import { RelationshipError } from './api.ts';
import { actor, fixtureFollow, memoryRelationships, target } from './fixtures.ts';
import { FollowingManager } from './manager.tsx';
import { messages } from './messages.ts';
import { RelationshipWatch } from './watch.tsx';

const shellCopy = { en: shell, de: { ...shell, ...shellDe }, es: { ...shell, ...shellEs }, fr: { ...shell, ...shellFr },
  ja: { ...shell, ...shellJa }, ko: { ...shell, ...shellKo }, 'zh-Hans': { ...shell, ...shellHans }, 'zh-Hant': { ...shell, ...shellHant } };

type State = 'signed-out' | 'empty' | 'thousands' | 'failed-read' | 'failed-write' | 'partial-write';
let lastMemory: ReturnType<typeof memoryRelationships>;
function RelationshipsScene({ state, locale }: { state: State; locale: UiLocale }) {
  const memory = useMemo(() => {
    const result = memoryRelationships(state === 'thousands' || state === 'failed-write' || state === 'partial-write'
    ? Array.from({ length: 1203 }, (_, i) => fixtureFollow(i + 10)) : [],
    state === 'failed-read' ? 'read' : state === 'failed-write' ? 'write' : undefined);
    if (state === 'partial-write') {
      const batch = result.api.batch;
      let count = 0;
      result.api.batch = async (edits, key) => {
        if (++count === 2) { result.calls.push({ operation: 'batch', body: edits, key }); throw new RelationshipError(503); }
        return batch(edits, key);
      };
    }
    return result;
  }, [state]);
  lastMemory = memory;
  const signedIn = state !== 'signed-out';
  const data: CommunityNavigation = { signedIn, avatarQuery: '', followed: state === 'failed-read' ? { realms: [], zones: [] } : null,
    official: [{ id: target(6), kind: 'zone', name: 'Official Fiction', language: 'en', href: '/r/fiction', icon: null, activity: 'unknown' }],
    moderated: state === 'thousands' ? [{ realm: target(10010), href: '/manage/r/fiction', open: 2, more: false }] : [],
    relationships: { actingSubject: signedIn ? actor : null, hasFollows: state === 'failed-read' ? null : memory.follows.size > 0,
      pinned: null, spaces: null } };
  return <AppShell locale={locale} messages={shellCopy[locale]} theme="light" navCollapsed={false} signedIn={signedIn}
    account={<a href="/auth/start">{messages[locale].signIn}</a>} communities={<CommunityNav data={data} api={memory.api} />}>
    <FollowingManager locale={locale} signedIn={signedIn} actingSubject={actor} signInHref="/auth/start" api={memory.api} />
  </AppShell>;
}

const meta = { title: 'Relationships/Inventory', component: RelationshipsScene,
  args: { state: 'thousands', locale: 'en' }, parameters: { route: { pathname: '/en/following' } },
  globals: { viewport: { value: 'desktop' } },
  async afterEach(context) {
    if (import.meta.env.VITE_G944_CAPTURE !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-944/screenshots/${context.id}.png` });
  },
} satisfies Meta<typeof RelationshipsScene>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Thousands: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const inventory = within(canvas.getByRole('region', { name: 'Following' }));
    await expect(await inventory.findByText('Community 29')).toBeVisible();
    await expect(inventory.queryByText('Community 30')).toBeNull();
    await userEvent.click(inventory.getByRole('checkbox', { name: 'Select · 中文网络小说' }));
    await userEvent.click(inventory.getByRole('button', { name: 'Load more' }));
    await expect(await inventory.findByText('Community 30')).toBeVisible();
    await expect(inventory.getByText('Selected: 1')).toBeVisible();
    await userEvent.selectOptions(inventory.getByLabelText('Notification level for selected'), 'off');
    await expect(await inventory.findByRole('button', { name: 'Notifications: Off' })).toBeVisible();
    await expect(inventory.queryByText('Selected: 1')).toBeNull();
    const nav = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(nav).queryByRole('region', { name: 'Official Zones' })).toBeNull();
    const spaces = within(within(nav).getByRole('region', { name: 'Communities and sites' }));
    await userEvent.click(spaces.getByRole('button', { name: 'Show all' }));
    await userEvent.type(spaces.getByRole('searchbox', { name: 'Search by name' }), 'Community 1212');
    await expect(await spaces.findByRole('link', { name: 'Community 1212' })).toBeVisible();
  },
};
export const Phone: Story = { globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Community 29')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const drawer = within(await within(document.body).findByRole('dialog', { name: 'Menu' }));
    await expect(await drawer.findByRole('region', { name: 'Pinned' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Manage follows' })).toHaveAttribute('href', '/en/following');
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth));
  } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const PhoneManager: Story = { globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Community 29');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };
export const PhoneManagerGerman: Story = { ...PhoneManager, args: { locale: 'de' } };
export const BulkSelection: Story = {
  async play({ canvasElement }) {
    const inventory = within(within(canvasElement).getByRole('region', { name: 'Following' }));
    await userEvent.click(await inventory.findByRole('checkbox', { name: 'Select · 中文网络小说' }));
    await expect(inventory.getByText('Selected: 1')).toBeVisible();
  } };
export const FailedWrite: Story = { args: { state: 'failed-write' },
  async play({ canvasElement }) {
    const inventory = within(within(canvasElement).getByRole('region', { name: 'Following' }));
    await userEvent.click(await inventory.findByRole('checkbox', { name: 'Select · 中文网络小说' }));
    await userEvent.click(inventory.getByRole('button', { name: 'Unfollow selected' }));
    await expect(await inventory.findByText('Couldn’t save. Try again.')).toBeVisible();
    await expect(inventory.getByText('Selected: 1')).toBeVisible();
  } };
export const PartialWrite: Story = { args: { state: 'partial-write' },
  async play({ canvasElement }) {
    const inventory = within(within(canvasElement).getByRole('region', { name: 'Following' }));
    await inventory.findByText('Community 29');
    for (const checkbox of inventory.getAllByRole('checkbox')) await userEvent.click(checkbox);
    await userEvent.click(inventory.getByRole('button', { name: 'Load more' }));
    for (let n = 30; n < 36; n++) await userEvent.click(await inventory.findByRole('checkbox', { name: `Select · Community ${n}` }));
    await expect(inventory.getByText('Selected: 26')).toBeVisible();
    await userEvent.click(inventory.getByRole('button', { name: 'Unfollow selected' }));
    await expect(await inventory.findByText('Selected: 6')).toBeVisible();
    await expect(await inventory.findByText(messages.en.partial)).toBeVisible();
    await userEvent.click(inventory.getByRole('button', { name: 'Unfollow selected' }));
    await waitFor(() => expect(inventory.queryByText('Selected: 6')).toBeNull());
    await expect(lastMemory.calls.filter(call => call.operation === 'batch').map(call => (call.body as unknown[]).length)).toEqual([20, 6, 6]);
    const batches = lastMemory.calls.filter(call => call.operation === 'batch');
    await expect(batches[1]!.key).toBe(batches[2]!.key);
    await expect(batches[1]!.body).toEqual(batches[2]!.body);
  } };
export const SignedOut: Story = { args: { state: 'signed-out' } };
export const Empty: Story = { args: { state: 'empty' } };
export const FailedRead: Story = { args: { state: 'failed-read' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByText(messages.en.unavailable).length).toBeGreaterThan(0));
    await expect(canvas.queryByRole('region', { name: 'Official Zones' })).toBeNull();
  } };

/** A resource header exercises level, pin, unfollow and per-thread Watch together. */
function Controls() {
  const memory = useMemo(() => memoryRelationships([{ ...fixtureFollow(10, 'work'), source: 'library' }]), []);
  lastMemory = memory;
  return <div className="grid max-w-lg gap-6 p-6">
    <RelationshipControl target={target(10)} kind="work" name="中文网络小说" locale="en" signedIn actingSubject={actor}
      signInHref="/auth/start" api={memory.api} />
    <RelationshipWatch target={target(20)} kind="collection" locale="en" signedIn actingSubject={actor} api={memory.api} />
  </div>;
}
export const SharedControls: Story = { render: () => <Controls />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Notifications: Highlights' }));
    await userEvent.click(await within(document.body).findByRole('menuitemradio', { name: 'All' }));
    await expect(await canvas.findByRole('button', { name: 'Notifications: All' })).toBeVisible();
    await expect(lastMemory.follows.get(target(10))?.source).toBe('library');
    await userEvent.click(canvas.getByRole('button', { name: 'Relationship options · 中文网络小说' }));
    const unpin = await within(document.body).findByRole('menuitem', { name: 'Unpin' });
    await waitFor(() => expect(unpin).toBeVisible());
    await userEvent.click(unpin);
    await waitFor(() => expect(lastMemory.calls.filter(call => call.operation === 'batch')).toHaveLength(2));
    await waitFor(() => expect(lastMemory.follows.get(target(10))?.pinPosition).toBeNull());
    await expect(lastMemory.follows.get(target(10))?.source).toBe('library');
    await userEvent.click(canvas.getByRole('button', { name: 'Following · 中文网络小说 · Unfollow' }));
    await expect(await canvas.findByRole('button', { name: 'Follow · 中文网络小说' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Watch' }));
    await expect(await canvas.findByRole('button', { name: 'Notifications: Participating' })).toBeVisible();
  } };
export const SignedOutTraditionalChinese: Story = { args: { state: 'signed-out', locale: 'zh-Hant' } };
export const EmptyTraditionalChinese: Story = { args: { state: 'empty', locale: 'zh-Hant' } };
export const ThousandsTraditionalChinese: Story = { args: { state: 'thousands', locale: 'zh-Hant' } };
export const FailedReadTraditionalChinese: Story = { args: { state: 'failed-read', locale: 'zh-Hant' } };
export const SignedOutSimplifiedChinese: Story = { args: { state: 'signed-out', locale: 'zh-Hans' } };
export const EmptySimplifiedChinese: Story = { args: { state: 'empty', locale: 'zh-Hans' } };
export const ThousandsSimplifiedChinese: Story = { args: { state: 'thousands', locale: 'zh-Hans' } };
export const FailedReadSimplifiedChinese: Story = { args: { state: 'failed-read', locale: 'zh-Hans' } };
export const SignedOutJapanese: Story = { args: { state: 'signed-out', locale: 'ja' } };
export const EmptyJapanese: Story = { args: { state: 'empty', locale: 'ja' } };
export const ThousandsJapanese: Story = { args: { state: 'thousands', locale: 'ja' } };
export const FailedReadJapanese: Story = { args: { state: 'failed-read', locale: 'ja' } };
export const SignedOutKorean: Story = { args: { state: 'signed-out', locale: 'ko' } };
export const EmptyKorean: Story = { args: { state: 'empty', locale: 'ko' } };
export const ThousandsKorean: Story = { args: { state: 'thousands', locale: 'ko' } };
export const FailedReadKorean: Story = { args: { state: 'failed-read', locale: 'ko' } };
export const SignedOutGerman: Story = { args: { state: 'signed-out', locale: 'de' } };
export const EmptyGerman: Story = { args: { state: 'empty', locale: 'de' } };
export const ThousandsGerman: Story = { args: { state: 'thousands', locale: 'de' } };
export const FailedReadGerman: Story = { args: { state: 'failed-read', locale: 'de' } };
export const SignedOutFrench: Story = { args: { state: 'signed-out', locale: 'fr' } };
export const EmptyFrench: Story = { args: { state: 'empty', locale: 'fr' } };
export const ThousandsFrench: Story = { args: { state: 'thousands', locale: 'fr' } };
export const FailedReadFrench: Story = { args: { state: 'failed-read', locale: 'fr' } };
export const SignedOutSpanish: Story = { args: { state: 'signed-out', locale: 'es' } };
export const EmptySpanish: Story = { args: { state: 'empty', locale: 'es' } };
export const ThousandsSpanish: Story = { args: { state: 'thousands', locale: 'es' } };
export const FailedReadSpanish: Story = { args: { state: 'failed-read', locale: 'es' } };
