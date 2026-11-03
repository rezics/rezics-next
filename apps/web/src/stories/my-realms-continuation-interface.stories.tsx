import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MyRealmsPageView } from '../community/my-realms-page';
import type { MyRealmsPage } from '../community/space';
import recording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import { ClosedErrorPage } from '../shell/closed';

const cursor = 'opaque-empty-page.cursor?next=2&keep=%2F';
const finalEmpty: MyRealmsPage = { signedIn: true, realms: [], next: null };
const sparseEmpty: MyRealmsPage = { signedIn: true, realms: [], next: cursor };
const populated: MyRealmsPage = {
  signedIn: true,
  realms: recording.items.map((item, index) => ({
    realmId: item.realmId,
    name: item.name,
    description:
      index === 0 ? 'A welcoming table for patient readers, long conversations, and notes worth keeping.' : null,
  })),
  next: cursor,
};
const longText: MyRealmsPage = {
  signedIn: true,
  realms: populated.realms.map((realm, index) => ({
    ...realm,
    name: `${realm.name} — ${'Readers sharing stories across languages and time zones 共讀社群 '.repeat(4)}`,
    description:
      index === 1
        ? null
        : `${'We read slowly, compare translations, and keep space for every reader. 共讀與交流筆記。 '.repeat(8)}${'UnbrokenReadingNotes'.repeat(16)}`,
  })),
  next: cursor,
};

/** Isolated supplied-page presentation: no query cache, server reader or native membership authority. */
function ContinuationExample({
  pages,
  direction = 'ltr',
  unavailable = false,
}: {
  pages: MyRealmsPage[];
  direction?: 'ltr' | 'rtl';
  unavailable?: boolean;
}) {
  const locale = getLocale();
  const router = useMemo(() => {
    const root = createRootRoute({
      component: () => (
        <main dir={direction} lang={locale} className="mx-auto min-w-0 max-w-5xl space-y-12 p-4 sm:p-8">
          {unavailable ? (
            <ClosedErrorPage error={new Error('Realm list is unavailable')} />
          ) : (
            pages.map((page, index) => <MyRealmsPageView key={index} page={page} />)
          )}
        </main>
      ),
    });
    return createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: [`/${locale}/realms`] }),
      rewrite: {
        input: ({ url }) => deLocalizeUrl(url).href,
        output: ({ url }) => localizeUrl(url).href,
      },
    });
  }, [pages, locale, direction, unavailable]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Pages/Community/My Realms Continuation Interface',
  component: ContinuationExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Supplied-page observations for the production MyRealmsPageView. Realm IDs, order and names derive from the recorded my-realms response; descriptions, long text and opaque continuations are presentation examples. Use en/zh-Hant and phone390/desktop1280 globals for every state; RTL exports stress direction with those supported locales. Plays observe unavailable entry, native continuation destinations, target size, wrapping and keyboard focus without fetching another page. Unavailable reuses the existing route error presentation. These examples establish no native signed-in admission, SSR or caller lifetime evidence.',
      },
    },
  },
  args: { pages: [populated], direction: 'ltr', unavailable: false },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    if (args.unavailable) {
      await expect(await canvas.findByRole('heading', { level: 1, name: m.error_heading() })).toBeVisible();
      await expect(canvas.getByText(m.error_message())).toBeVisible();
      await expect(canvas.queryByText(m.realms_empty())).toBeNull();
      await expect(canvas.queryByText(m.realm_list_details_sparse_page_empty())).toBeNull();
      await expect(canvas.queryByRole('link', { name: m.realms_more() })).toBeNull();
      await expect(canvasElement.querySelector('[data-slot="list-row"]')).toBeNull();
      return;
    }

    await canvas.findAllByRole('heading', { level: 1, name: m.realms_heading() });
    const articles = [...canvasElement.querySelectorAll('article')];
    await expect(articles).toHaveLength(args.pages.length);
    const headingIds: string[] = [];
    for (const [index, article] of articles.entries()) {
      const page = args.pages[index]!;
      const view = within(article);
      const rows = [...article.querySelectorAll('[data-slot="list-row"]')];
      await expect(rows).toHaveLength(page.realms.length);
      await expect(article.querySelector('img, picture, source')).toBeNull();
      for (const [rowIndex, row] of rows.entries()) {
        const realm = page.realms[rowIndex]!;
        const heading = within(row as HTMLElement).getByRole('heading', { level: 2, name: realm.name });
        headingIds.push(heading.id);
        await expect(heading).toBeVisible();
        await expect(within(row as HTMLElement).getByText(m.realms_entry_unavailable())).toBeVisible();
        await expect(row.querySelectorAll('a')).toHaveLength(0);
        if (realm.description) {
          const description = row.querySelector('p');
          await expect(description).toHaveTextContent(realm.description);
          await expect(description).toHaveAttribute('class', 'text-sm leading-relaxed text-muted-foreground');
        } else await expect(row.querySelector('[data-content-item-slot="preview"]')).toBeNull();
      }

      if (page.realms.length === 0) {
        const copy = page.next ? m.realm_list_details_sparse_page_empty() : m.realms_empty();
        await expect(view.getByText(copy)).toBeVisible();
        await expect(
          view.queryByText(page.next ? m.realms_empty() : m.realm_list_details_sparse_page_empty()),
        ).toBeNull();
      } else {
        await expect(view.queryByText(m.realms_empty())).toBeNull();
        await expect(view.queryByText(m.realm_list_details_sparse_page_empty())).toBeNull();
      }

      if (page.next) {
        const navigation = view.getByRole('navigation', { name: m.realms_heading() });
        const next = within(navigation).getByRole('link', { name: m.realms_more() });
        const href = next.getAttribute('href');
        await expect(href).toBeTruthy();
        const destination = new URL(href!, window.location.origin);
        await expect(destination.pathname).toBe(`/${getLocale()}/realms`);
        await expect([...destination.searchParams.keys()]).toEqual(['cursor']);
        await expect(destination.searchParams.get('cursor')).toBe(page.next);
        await expect(destination.hash).toBe('');
        await expect(next).toBeVisible();
        await expect(next.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await expect(next.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        await expect(getComputedStyle(next).whiteSpace).toBe('normal');
        for (let step = 0; step < 70 && document.activeElement !== next; step += 1) await userEvent.tab();
        await expect(next).toHaveFocus();
        await expect(parseFloat(getComputedStyle(next).outlineWidth)).toBeGreaterThanOrEqual(2);
        await expect(getComputedStyle(next).outlineStyle).not.toBe('none');
      } else {
        await expect(view.queryByRole('navigation')).toBeNull();
        await expect(view.queryByRole('link', { name: m.realms_more() })).toBeNull();
      }
      await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
    }
    await expect(new Set(headingIds).size).toBe(headingIds.length);
    const main = canvas.getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  },
} satisfies Meta<typeof ContinuationExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FinalEmpty: Story = {
  args: { pages: [finalEmpty] },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
};
export const SparseEmpty: Story = {
  args: { pages: [sparseEmpty] },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const PopulatedWithNext: Story = {
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
};
export const PopulatedWithoutNext: Story = {
  args: { pages: [{ ...populated, next: null }] },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const FinalEmptyTraditionalChinese: Story = {
  args: { pages: [finalEmpty] },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const SparseEmptyTraditionalChinese: Story = {
  args: { pages: [sparseEmpty] },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
};
export const PopulatedTraditionalChinese: Story = {
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const PopulatedWithoutNextTraditionalChinese: Story = {
  args: { pages: [{ ...populated, next: null }] },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
};
export const LongTextPhone: Story = {
  args: { pages: [longText] },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const LongTextDesktop: Story = {
  args: { pages: [{ ...longText, next: null }] },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
};
export const SparseEmptyRtl: Story = {
  args: { pages: [sparseEmpty], direction: 'rtl' },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const MultipleInstancesRtl: Story = {
  args: { pages: [longText, { ...populated, next: null }], direction: 'rtl' },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
};
export const Unavailable: Story = {
  args: { pages: [], unavailable: true },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const UnavailableTraditionalChinese: Story = {
  args: { pages: [], unavailable: true },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
};
