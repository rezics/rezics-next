import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PublicProfilePage } from '../accounts/public-profile/page';
import { storyAccountProfileBinding } from './public-profile-binding';
import { profilePage } from './pages/accounts-public-profile/fixtures';
import { preparedProfileContributions } from '../kernel/fake/profile-contribution-reading';
import { isRecord } from '../features/pages/shared';
import { subjectPageMessages } from '../features/pages/route-support';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

function Reading({
  state = 'context',
}: {
  state?: 'context' | 'unavailable' | 'concealed' | 'invalid-cursor' | 'long';
}) {
  const [generation, replace] = useState(0);
  const page = profilePage();
  const prepared = preparedProfileContributions();
  prepared.reply.authorId = page.account!.id;
  prepared.review.authorId = page.account!.id;
  if (state === 'long') {
    prepared.review.title = '閱讀の記憶 · Les voix du monde · 긴 이름 '.repeat(12);
    prepared.reply.thread.title = prepared.review.title;
  }
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    if (Array.isArray(result.body.posts)) result.body.posts = [prepared.reply];
    if (Array.isArray(result.body.threads)) result.body.threads = [prepared.review];
    if (state === 'unavailable') {
      for (const field of ['posts', 'threads']) {
        const rows = result.body[field];
        if (Array.isArray(rows))
          for (const row of rows)
            if (isRecord(row)) {
              delete row.reviewContext;
              delete row.parentContext;
            }
      }
    }
    if (state === 'concealed' && Array.isArray(result.body.accounts))
      for (const account of result.body.accounts)
        if (isRecord(account)) account.publicViews = { posts: false, reviews: false };
    if (state === 'invalid-cursor' && (Array.isArray(result.body.posts) || Array.isArray(result.body.threads))) {
      result.status = 400;
      result.body = { code: 'invalid_cursor' };
    }
  }
  return (
    <PatternStory visitor="Signed Out" path={`/@${page.account!.handle}`}>
      <main className="mx-auto max-w-5xl p-4 sm:p-8">
        <p className="my-3 text-sm text-muted-foreground">
          Prepared native-shaped context; not native eligibility evidence.
        </p>
        <button className="min-h-11 rounded border px-3" onClick={() => replace(generation + 1)}>
          Replace profile visit
        </button>
        <PublicProfilePage
          key={generation}
          profile={storyAccountProfileBinding}
          page={page}
          locale={getLocale()}
          messages={subjectPageMessages()}
          base={`/${getLocale()}/@${page.account!.handle}`}
          publicRealms={false}
          renderJsonLd={false}
        />
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Account/Contribution context',
  id: 'pages-account-contribution-context',
  component: Reading,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Reading>;
export default meta;
type Story = StoryObj<typeof meta>;

const journey: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvasElement.querySelector('[data-profile-contribution-kind="review"]')).not.toBeNull();
  await expect(canvasElement.querySelector('[data-profile-contribution-kind="reply"]')).not.toBeNull();
  await expect(canvas.queryByText('Prepared hidden ending')).toBeNull();
  await expect(canvas.queryByText('Prepared concealed parent ending')).toBeNull();
  const parent = canvasElement.querySelector<HTMLElement>('[data-feed-parent-context="available"]')!;
  const reveal = within(parent).getByRole('button');
  reveal.focus();
  await expect(reveal).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(within(parent).getByText('Prepared concealed parent ending')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Replace profile visit' }));
  await expect(canvas.queryByText('Prepared concealed parent ending')).toBeNull();
  const primary = canvasElement.querySelector<HTMLAnchorElement>(
    '[data-slot="account-posts-items"] a[data-slot="list-row-link"]',
  )!;
  await expect(primary).toHaveAttribute(
    'href',
    expect.stringContaining(`?post=${preparedProfileContributions().reply.id}#post-`),
  );
  primary.focus();
  await userEvent.tab();
  await expect(primary).not.toHaveFocus();
  await expect(canvasElement.querySelector('a a, a button, button a')).toBeNull();
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
};

export const PhoneLight: Story = { name: 'Default', globals: {}, play: journey };
export const PhoneDark: Story = { tags: ['!dev'], globals: {}, play: journey };
export const DesktopLight: Story = { tags: ['!dev'], globals: {}, play: journey };
export const DesktopDark: Story = { tags: ['!dev'], globals: {}, play: journey };
export const LongKeyboard: Story = {
  args: { state: 'long' },
  globals: {},
  play: journey,
};
export const UnavailableContext: Story = { args: { state: 'unavailable' } };
export const HiddenCategories: Story = { args: { state: 'concealed' } };
export const InvalidCursor: Story = { args: { state: 'invalid-cursor' } };
