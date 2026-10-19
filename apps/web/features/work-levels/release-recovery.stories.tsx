import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { ReleaseSources, ReleaseView } from './release-page.tsx';
import { copyOf as detailCopy } from '../entity-page/messages.ts';
import { AppShell, MAIN_CONTENT_ID } from '../shell/app-shell.tsx';
import { PageContainer } from '../shell/page.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJapanese from '../shell/messages/ja.ts';
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
  const selected = { release: { ...release, coverage: [coverage, hidden] }, realizations: new Map(),
    sources: [], names, locale, t: copyOf(locale) };
  return <StoryRouteContext value={{ pathname: '/release/known', onRefresh: () => setRecovered(true) }}>
    <AppShell locale={locale} messages={locale === 'ja' ? shellJapanese : shellMessages}
      theme={locale === 'ja' ? 'dark' : 'light'} navCollapsed={false} account={null}
      pageEnd={<PageContainer className="max-w-4xl pt-0 sm:pt-0 lg:pt-0"><ReleaseSources {...selected} /></PageContainer>}>
      <PageContainer className="max-w-4xl"><ReleaseView {...selected} pageEndSources /></PageContainer>
    </AppShell>
  </StoryRouteContext>;
}

const meta = { title: 'Work/Release recovery', component: PartialRelease } satisfies Meta<typeof PartialRelease>;
export default meta;
type Story = StoryObj<typeof meta>;

async function verifyPageEnd(canvasElement: HTMLElement, locale: UiLocale) {
  const canvas = within(canvasElement);
  const mains = canvas.getAllByRole('main');
  await expect(mains).toHaveLength(1);
  const main = mains[0]!;
  await expect(main).toHaveAttribute('id', MAIN_CONTENT_ID);
  await expect(main).toHaveAttribute('tabindex', '-1');
  const footers = canvas.getAllByRole('contentinfo', { name: detailCopy(locale).sources });
  await expect(footers).toHaveLength(1);
  const footer = footers[0]!;
  await expect(footer.closest('main')).toBeNull();
  await expect(Boolean(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  await expect(canvasElement.querySelectorAll('[data-subject-sources]')).toHaveLength(1);
  await expect(within(footer).getByText(`${detailCopy(locale).releaseRevision}: ${release.revision}`)).toBeVisible();
  footer.scrollIntoView({ block: 'end' });
  const bottomNavigation = canvasElement.querySelector<HTMLElement>('nav.fixed');
  if (bottomNavigation && getComputedStyle(bottomNavigation).display !== 'none') {
    await waitFor(() => expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottomNavigation.getBoundingClientRect().top));
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

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
    await verifyPageEnd(canvasElement, 'en');
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
    await verifyPageEnd(canvasElement, 'ja');
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
    await verifyPageEnd(canvasElement, 'en');
  },
};
