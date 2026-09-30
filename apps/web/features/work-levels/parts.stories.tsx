import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { PartsSection } from './parts.tsx';
import { PartsPreviewView } from './previews.tsx';
import type { ConnectionsQuery } from './route.ts';
import type { Loaded, PartsPage } from './types.ts';

function Page({ locale, parts = fixture.parts, preview = false, query = { grain: 'series' } }: {
  locale: UiLocale; parts?: Loaded<PartsPage>; preview?: boolean; query?: ConnectionsQuery;
}) {
  const t = copyOf(locale);
  return <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
    {preview
      ? <PartsPreviewView parts={parts} wholes={fixture.wholes} names={fixture.names} workRef={fixture.workRef}
        pageMessages={pageMessages[locale]} t={t} />
      : <PartsSection parts={parts} wholes={fixture.wholes} names={fixture.names} workRef={fixture.workRef} query={query}
        locale={locale} t={t} pageMessages={pageMessages[locale]} />}
  </div>;
}

const meta = { title: 'Work levels/Parts', component: Page, args: { locale: 'en' } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** New Testament lists "22" and "22 Reverse" as separate parts in the order Main keeps; an extra and an optional part say so. */
export const PublicationOrder: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list', { name: 'Parts in publication order' });
    const rows = within(list).getAllByRole('listitem').map(item => item.textContent);
    await expect(rows[1]).toContain('22');
    await expect(rows[2]).toContain('22 Reverse');
    await expect(rows[1]).not.toContain('Reverse');
    await expect(within(list).getByText('Extra')).toBeVisible();
    await expect(canvas.getByText('Part of')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'A Certain Magical Index' })).toBeVisible();
    await expect(canvas.getByText(/Concluded/)).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const ContinuesWithShowMore: Story = { args: { parts: fixture.pagedParts },
  async play({ canvasElement }) {
    const more = within(canvasElement).getByRole('link', { name: 'Show more' });
    await expect(more).toHaveAttribute('href', expect.stringContaining('partsAfter=cursor-2'));
    await expect(more.getAttribute('href')).toContain('#parts');
  } };

export const Phone: Story = { args: { locale: 'ja' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: '構成' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };

export const SignInNeeded: Story = { args: { parts: { ok: false, failure: 'sign-in' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Parts could not be loaded.');
  } };

/** A Work with no composition is answered 404; the page says it has no parts rather than that something failed. */
export const NoParts: Story = { args: { parts: { ok: false, failure: 'missing' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No parts' })).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
  } };

export const Preview: Story = { args: { preview: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'All parts' })).toHaveAttribute('href', `/en/w/${fixture.workRef}/connections#parts`);
  } };
