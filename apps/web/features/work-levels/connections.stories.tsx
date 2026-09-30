import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { ConnectionsSection, type Franchise } from './connections.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { ConnectionsPreviewView } from './previews.tsx';
import type { ConnectionsQuery } from './route.ts';
import type { Loaded, RelationsPage } from './types.ts';

const franchise = (grain: 'series' | 'parts'): Franchise => ({
  collection: fixture.summary(fixture.iri('900'), 'A Certain Magical Index franchise', 'en', 'collection'),
  members: { ok: true, data: { collection: fixture.iri('900'), next: null, members: [fixture.iri('100'), fixture.iri('200'), fixture.iri('300')].map((target, index) => ({
    occurrence: fixture.iri(`8${index}`), role: 'member', parent: fixture.iri('9'), target, orderKey: `o${index}`, labels: [] })) } },
  parts: grain === 'parts' && fixture.parts.ok ? new Map([[fixture.iri('100'), fixture.parts]]) : new Map() });

function Page({ locale, grain = 'series', relations = fixture.relations, preview = false }: {
  locale: UiLocale; grain?: ConnectionsQuery['grain']; relations?: Loaded<RelationsPage>; preview?: boolean;
}) {
  const t = copyOf(locale);
  return <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
    {preview
      ? <ConnectionsPreviewView relations={relations} workRef={fixture.workRef} locale={locale} pageMessages={pageMessages[locale]} t={t} />
      : <ConnectionsSection relations={relations} franchises={[franchise(grain)]} names={fixture.names} workRef={fixture.workRef}
        current={fixture.current} query={{ grain }} locale={locale} t={t} pageMessages={pageMessages[locale]} />}
  </div>;
}

const meta = { title: 'Work levels/Connections', component: Page, args: { locale: 'en' } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Progressive shows Reboot and AGGO shows SpinOff: each row's heading is the label Main selected, its counterparts follow. */
export const TypedRelations: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const rows = canvasElement.querySelectorAll('[data-relation-row]');
    await expect(rows).toHaveLength(3);
    await expect(within(rows[0] as HTMLElement).getByText('Reboot of')).toBeVisible();
    await expect(within(rows[1] as HTMLElement).getByText('Spin-offs')).toBeVisible();
    await expect(within(rows[1] as HTMLElement).getAllByRole('link')).toHaveLength(2);
    // The derivation whose source version is not pinned is visibly unresolved, not hidden.
    await expect(canvas.getByText('Source version unresolved')).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-role-chip]')).toHaveLength(0);
  },
};

/** A label in another language than the reader asked for keeps its own language and direction and is marked. */
export const LabelFallback: Story = {
  async play({ canvasElement }) {
    const chips = canvasElement.querySelectorAll('[lang="ja"]');
    await expect(chips.length).toBeGreaterThan(0);
    await expect(within(canvasElement).getByText(/続編元/)).toBeVisible();
    await expect(within(canvasElement).getByText('in Japanese')).toBeVisible();
  },
};

/** The franchise lists its series; switching the grain lists their parts underneath. */
export const SeriesGrain: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'A Certain Magical Index franchise' })).toBeVisible();
    await expect(canvas.getByText('This Work')).toBeVisible();
    const switcher = canvas.getByRole('group', { name: 'Franchise level' });
    await expect(within(switcher).getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'true');
    await expect(within(switcher).getByRole('link', { name: 'Volumes and parts' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/connections?grain=parts#franchises`);
    await expect(canvas.queryByText('A Certain Magical Index NT 22 Reverse')).toBeNull();
  },
};

export const PartsGrain: Story = { args: { grain: 'parts' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('group', { name: 'Franchise level' })).getByRole('link', { name: 'Volumes and parts' }))
      .toHaveAttribute('aria-current', 'true');
    await expect(canvas.getByText('A Certain Magical Index NT 22 Reverse')).toBeVisible();
  } };

export const Japanese: Story = { args: { locale: 'ja' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: 'つながり' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };

export const Preview: Story = { args: { preview: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'All connections' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/connections#relations`);
  } };

export const SignInNeeded: Story = { args: { relations: { ok: false, failure: 'sign-in' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Connections could not be loaded.');
  } };
