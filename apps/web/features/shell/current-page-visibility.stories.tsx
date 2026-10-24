import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { browseCategories } from '../catalogue/registry.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import { browseHref, emptyBrowse } from '../discover/browse-state.ts';
import { fixturePage } from '../discover/browse-fixtures.ts';
import { DiscoverView } from '../discover/discover-view.tsx';
import { Providers } from './providers.tsx';
import LocalizedLink from './localized-link.tsx';

/** Remount the real Discover navigation: Storybook does not emulate a replacement document request. */
function DiscoverNavigation({ tab, locale }: { tab: string; locale: UiLocale }) {
  const [revision, setRevision] = useState(0);
  const [filtered, setFiltered] = useState(false);
  return <>
    <div className="flex gap-2 p-4">
      <button className="rounded-lg border px-3 py-2" onClick={() => setRevision(value => value + 1)}>Remount navigation</button>
      <button className="rounded-lg border px-3 py-2" onClick={() => setFiltered(value => !value)}>Change filter</button>
    </div>
    <Providers key={revision}>
      <DiscoverView locale={locale} state={{ ...emptyBrowse, tab, q: filtered ? 'rain' : '' }}
        signedIn={false} topics={[]} sections={null} results={{ ok: true, data: fixturePage([]) }} />
    </Providers>
  </>;
}

const meta = {
  title: 'Shell/Current page visibility', component: DiscoverNavigation,
  args: { tab: 'topics', locale: 'en' },
  globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en/discover' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const current = () => {
      const nav = canvas.getByRole('navigation', { name: browseMessages[args.locale].type });
      return { nav, link: nav.querySelector<HTMLAnchorElement>('a[aria-current="page"]')! };
    };
    const visible = async () => {
      await waitFor(async () => {
        const { nav, link } = current();
        const row = nav.getBoundingClientRect(), selected = link.getBoundingClientRect();
        await expect(selected.left).toBeGreaterThanOrEqual(row.left - 1);
        await expect(selected.right).toBeLessThanOrEqual(row.right + 1);
      });
    };
    await visible();
    const category = browseCategories().find(item => item.id === args.tab)!;
    await expect(current().link).toHaveAccessibleName(category.labels[args.locale]);
    await expect(within(current().nav).getAllByRole('link')).toHaveLength(browseCategories().length + 1);
    await userEvent.click(canvas.getByRole('button', { name: 'Remount navigation' }));
    await visible();
    await userEvent.click(canvas.getByRole('button', { name: 'Change filter' }));
    await visible();
    await expect(current().link.href).toContain('q=rain');
    // History restoration must reveal selection without moving the document vertically.
    current().nav.scrollLeft = 0;
    const verticalPosition = window.scrollY;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await visible();
    await expect(window.scrollY).toBe(verticalPosition);
    for (const link of within(current().nav).getAllByRole('link')) {
      link.focus();
      await expect(link).toHaveFocus();
    }
    current().link.focus();
    await visible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
} satisfies Meta<typeof DiscoverNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Topics: Story = {};
export const Lists: Story = { args: { tab: 'lists' } };
export const People: Story = { args: { tab: 'people' } };
export const Desktop: Story = { globals: { viewport: { value: 'desktop1440' } } };
export const ChineseDark: Story = {
  args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', theme: 'dark' },
};

function NestedNavigation() {
  const selected = useRef<HTMLAnchorElement>(null);
  return <div className="p-4">
    <button className="mb-4 rounded-lg border px-3 py-2" onClick={() => selected.current?.focus()}>Focus selection</button>
    <nav aria-label="Destinations">
      <div className="overflow-x-auto pb-1">
        <ul className="flex w-max gap-1">
          {browseCategories().map(category => <li key={category.id}>
            <LocalizedLink ref={category.id === 'topics' ? selected : undefined}
              href={browseHref({ ...emptyBrowse, tab: category.id })}
              aria-current={category.id === 'topics' ? 'page' : undefined}
              className="inline-flex h-10 items-center whitespace-nowrap rounded-full px-4
                aria-[current=page]:bg-foreground aria-[current=page]:text-background">
              {category.labels.en}
            </LocalizedLink>
          </li>)}
        </ul>
      </div>
    </nav>
  </div>;
}

export const NestedRowAndResize: Story = {
  render: () => <NestedNavigation />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole('navigation', { name: 'Destinations' });
    const row = nav.firstElementChild as HTMLElement;
    const current = within(nav).getByRole('link', { name: 'Topics' });
    const visible = () => waitFor(async () => {
      const bounds = row.getBoundingClientRect(), link = current.getBoundingClientRect();
      await expect(link.left).toBeGreaterThanOrEqual(bounds.left - 1);
      await expect(link.right).toBeLessThanOrEqual(bounds.right + 1);
    });
    await visible();
    row.style.width = '240px';
    await visible();
    await userEvent.click(canvas.getByRole('button', { name: 'Focus selection' }));
    await expect(current).toHaveFocus();
    await visible();
  },
};
