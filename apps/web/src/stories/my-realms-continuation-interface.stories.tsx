import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MyRealmsPageView } from '../community/my-realms-page';
import type { MyRealmsPage } from '../community/space';
import type { MyRealmsNavigation } from '../community/my-realms-caller';
import type { MyRealmsCurrentRow, MyRealmsNativePage } from '../community/my-realms-current/contract';
import { formatMyRealmsCurrent } from '../community/my-realms-native';
import recording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import { ClosedErrorPage } from '../shell/closed';

const cursor = 'opaque-empty-page.cursor?next=2&keep=%2F';
const finalEmpty: MyRealmsPage = { signedIn: true, realms: [], next: null };
const sparseEmpty: MyRealmsPage = { signedIn: true, realms: [], next: cursor };
const recordedRows = formatMyRealmsCurrent(recording as unknown as MyRealmsNativePage).realms;

function currentRow(index: number, name: string, description: string): MyRealmsCurrentRow {
  const source = recordedRows[0];
  if (!source) throw new Error('The refreshed My Realms recording needs a current row.');
  const realmId = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
  const replacePath = (action: MyRealmsCurrentRow['current']['actions']['enter'], suffix: string) =>
    action.state === 'available' ? { ...action, path: `/v1/realms/${realmId}${suffix}` } : action;
  return {
    ...source,
    realmId,
    name,
    current: {
      ...source.current,
      description,
      destination: { ...source.current.destination, realmId },
      actions: {
        ...source.current.actions,
        enter: replacePath(source.current.actions.enter, ''),
        manage: replacePath(source.current.actions.manage, '/settings'),
        leave: replacePath(source.current.actions.leave, '/membership'),
      },
    },
  };
}

const populated: MyRealmsPage = {
  signedIn: true,
  realms: recordedRows.map((row, index) =>
    currentRow(
      index,
      row.name,
      index === 0
        ? 'A welcoming table for patient readers, long conversations, and notes worth keeping.'
        : row.current.description,
    ),
  ),
  next: cursor,
};
const longText: MyRealmsPage = {
  signedIn: true,
  realms: Array.from({ length: 20 }, (_, index) =>
    currentRow(
      index + 1,
      `${recordedRows[0]!.name} ${'Readers sharing stories across languages and time zones 共讀社群 '.repeat(4)}`,
      `${'We read slowly, compare translations, and keep space for every reader. 共讀與交流筆記。 '.repeat(8)}${'UnbrokenReadingNotes'.repeat(16)}`,
    ),
  ),
  next: cursor,
};

/** Supplied current pages with presentation-only descriptions and continuation coordinates. */
function ContinuationExample({
  pages,
  direction = 'ltr',
  unavailable = false,
  navigation,
}: {
  pages: MyRealmsPage[];
  direction?: 'ltr' | 'rtl';
  unavailable?: boolean;
  navigation?: MyRealmsNavigation;
}) {
  const locale = getLocale();
  const router = useMemo(() => {
    const root = createRootRoute({
      component: () => (
        <main dir={direction} lang={locale} className="mx-auto min-w-0 max-w-5xl space-y-12 p-4 sm:p-8">
          {unavailable ? (
            <ClosedErrorPage error={new Error('Realm list is unavailable')} />
          ) : (
            pages.map((page, index) => <MyRealmsPageView key={index} page={page} navigation={navigation} />)
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
  }, [pages, locale, direction, unavailable, navigation]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Community/My Realms Continuation Interface',
  id: 'pages-community-my-realms-continuation-interface',
  component: ContinuationExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Current identity, media and advice derive from the recorded My Realms response. Long text and opaque continuations are presentation examples. These stories exercise sparse and final pages, native continuation destinations, finite Previous/First navigation, target size, wrapping and keyboard focus without fetching another page. They do not establish SSR or caller lifetime evidence.',
      },
    },
  },
  args: { pages: [populated], direction: 'ltr', unavailable: false },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    if (args.unavailable) {
      await expect(await canvas.findByRole('heading', { level: 1, name: m.error_heading() })).toBeVisible();
      await expect(canvas.getByText(m.route_error_description())).toBeVisible();
      await expect(canvas.queryByText(m.realms_empty())).toBeNull();
      await expect(canvas.queryByText(m.realm_list_details_sparse_page_empty())).toBeNull();
      await expect(canvas.queryByRole('link', { name: m.realms_more() })).toBeNull();
      await expect(canvasElement.querySelector('[data-slot="my-realms-item"]')).toBeNull();
      return;
    }

    await canvas.findAllByRole('heading', { level: 1, name: m.realms_heading() });
    const articles = [...canvasElement.querySelectorAll('[data-slot="my-realms-page"]')];
    await expect(articles).toHaveLength(args.pages.length);
    const headingIds: string[] = [];
    for (const [index, article] of articles.entries()) {
      const page = args.pages[index]!;
      const view = within(article as HTMLElement);
      const rows = [...article.querySelectorAll('[data-slot="my-realms-item"]')];
      await expect(rows).toHaveLength(page.realms.length);
      for (const [rowIndex, row] of rows.entries()) {
        const realm = page.realms[rowIndex]!;
        const item = within(row as HTMLElement);
        const heading = item.getByRole('heading', { level: 2, name: realm.name });
        headingIds.push(heading.id);
        await expect(heading).toBeVisible();
        await expect(row.querySelector('header p')).toHaveTextContent(realm.current.description);
        if (realm.current.actions.enter.state === 'available')
          await expect(item.getByRole('link', { name: m.my_realms_open() })).toBeVisible();
        else await expect(item.queryByRole('link', { name: m.my_realms_open() })).toBeNull();
        if (realm.current.actions.manage.state === 'available')
          await expect(item.getByRole('link', { name: m.my_realms_manage() })).toBeVisible();
        else await expect(item.queryByRole('link', { name: m.my_realms_manage() })).toBeNull();
        const media = [realm.current.avatar, realm.current.banner];
        if (media.some((image) => image.state === 'none'))
          await expect(item.getAllByText(m.realm_appearance_no_image())).not.toHaveLength(0);
        if (media.some((image) => image.state === 'unavailable'))
          await expect(item.getAllByText(m.realm_appearance_image_unavailable())).not.toHaveLength(0);
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
      await expect((article as HTMLElement).scrollWidth).toBeLessThanOrEqual((article as HTMLElement).clientWidth + 1);
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
  globals: { locale: 'en' },
};
export const SparseEmpty: Story = {
  args: { pages: [sparseEmpty] },
  globals: { locale: 'en' },
};
export const PopulatedWithNext: Story = { globals: { locale: 'en' } };
export const PopulatedWithoutNext: Story = {
  args: { pages: [{ ...populated, next: null }] },
  globals: { locale: 'en' },
};
export const FinalEmptyTraditionalChinese: Story = {
  args: { pages: [finalEmpty] },
  globals: { locale: 'zh-Hant' },
};
export const SparseEmptyTraditionalChinese: Story = {
  args: { pages: [sparseEmpty] },
  globals: { locale: 'zh-Hant' },
};
export const PopulatedTraditionalChinese: Story = { globals: { locale: 'zh-Hant' } };
export const PopulatedWithoutNextTraditionalChinese: Story = {
  args: { pages: [{ ...populated, next: null }] },
  globals: { locale: 'zh-Hant' },
};
export const LongTextWithContinuation: Story = {
  args: { pages: [longText] },
  globals: { locale: 'zh-Hant' },
};
export const LongTextLastPage: Story = {
  args: { pages: [{ ...longText, next: null }] },
  globals: { locale: 'en' },
};
export const SparseEmptyRtl: Story = {
  args: { pages: [sparseEmpty], direction: 'rtl' },
  globals: { locale: 'en' },
};
export const MultipleInstancesRtl: Story = {
  args: { pages: [longText, { ...populated, next: null }], direction: 'rtl' },
  globals: { locale: 'zh-Hant' },
};
export const Unavailable: Story = {
  args: { pages: [], unavailable: true },
  globals: { locale: 'en' },
};
export const UnavailableTraditionalChinese: Story = {
  args: { pages: [], unavailable: true },
  globals: { locale: 'zh-Hant' },
};
