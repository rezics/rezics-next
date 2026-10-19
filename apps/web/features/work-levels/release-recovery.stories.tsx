import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { ReleaseView } from './release-page.tsx';
import { releases, names as fixtureNames, iri, summary } from './fixtures.ts';
import { copyOf } from './messages.ts';
import type { NameSummary } from './types.ts';

if (!releases.ok) throw new Error('Expected a disclosed release fixture');
const release = releases.data.items[0]!;

/** Contract fixtures demonstrate partial names; they are not public publication proof. */
function PartialRelease({ locale = 'en' }: { locale?: UiLocale }) {
  const [recovered, setRecovered] = useState(false);
  const names = new Map<string, NameSummary>(fixtureNames);
  const coverage = release.coverage[0]!;
  names.set(coverage.work, summary(coverage.work, 'Known sibling Work'));
  names.set(coverage.mainVersion, recovered ? summary(coverage.mainVersion, 'Recovered main version', 'en', 'main-version')
    : { reference: coverage.mainVersion, status: 'unavailable-read' });
  const hidden = { ...coverage, work: iri('910'), mainVersion: iri('911'), realization: null, revision: null };
  names.set(hidden.work, { reference: hidden.work, status: 'unavailable' });
  names.set(hidden.mainVersion, summary(hidden.mainVersion, '', 'en', 'main-version'));
  return <StoryRouteContext value={{ pathname: '/release/known', onRefresh: () => setRecovered(true) }}>
    <main className="mx-auto max-w-4xl px-4 py-6"><ReleaseView
    release={{ ...release, coverage: [coverage, hidden] }} realizations={new Map()} sources={[]}
    names={names} locale={locale} t={copyOf(locale)} /> </main></StoryRouteContext>;
}

const meta = { title: 'Work/Release recovery', component: PartialRelease } satisfies Meta<typeof PartialRelease>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialNames: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'What it covers' })).toBeVisible();
    await expect(canvas.getAllByText('Known sibling Work')[0]!).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(canvas.getByText('Name not shown')).toBeVisible();
    await expect(canvas.getByText('Unnamed')).toBeVisible();
    await expect(canvasElement.querySelector('[data-name-state="unavailable"]')).toHaveTextContent('Unavailable');
    await expect(canvas.queryByText(copyOf('en').noCoverage)).toBeNull();
  },
};

export const PartialNamesPhoneDarkJapanese: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(copyOf('ja').namesUnavailable)).toBeVisible();
    await expect(canvas.getAllByText('Known sibling Work')[0]!).toBeVisible();
    await expect(canvasElement.querySelector('[data-name-state="undisclosed"]')).toHaveTextContent(copyOf('ja').nameNotShown);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NamesRecoverInPlace: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(canvas.getByText('Recovered main version')).toBeVisible();
    await expect(canvas.getAllByText('Known sibling Work')[0]!).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Retry' })).toHaveFocus();
    await expect(canvas.getByRole('status')).toHaveTextContent(copyOf('en').namesRestored);
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.getByRole('heading', { name: 'Sources and licenses' })).toBeVisible();
  },
};
