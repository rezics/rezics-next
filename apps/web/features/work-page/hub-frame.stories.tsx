import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { PageContainer } from '../shell/page.tsx';
import * as tracking from '../tracking/fixtures.ts';
import { createMemoryMain, memoryReader } from '../tracking/memory.ts';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { hubLabels, hubSections } from './hub.ts';
import { messages } from './messages.ts';
import { IdentityStatus, type NextAction, NextActionView } from './primary-action.tsx';
import { workHref } from './route.ts';
import { OverviewLayout, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';
import { YourEdition } from './your-edition.tsx';

const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

interface FrameArgs { locale: UiLocale; action: NextAction | null }

/** Identity and the next action around a short overview, with the phone's "On this page" menu. */
function Frame({ locale, action }: FrameArgs) {
  const t = messages[locale];
  const progress = { ok: true as const, data: tracking.indexSummary };
  return <WorkFrame workRef={fixture.workRef} work={fixture.work} locale={locale} messages={t}
    sections={hubLabels(t, hubSections)}
    credits={<WorkCredits agentCredits={fixture.agentCredits} credits={fixture.credits} locale={locale} messages={t} />}
    readAction={action ? <NextActionView action={action} workRef={fixture.workRef} locale={locale} messages={t} /> : undefined}
    status={<IdentityStatus progress={progress} preference={{ ok: true, data: tracking.indexSummary.preference }}
      editionName="Sword Art Online 1: Aincrad" locale={locale} messages={t} />}>
    <OverviewLayout messages={t} plan={hubSections} scopeBar={null} ratings={null}
      about={<WorkAbout work={fixture.work} messages={t} />} record={null}
      availability={<p>Availability</p>} parts={<p>Parts</p>} wiki={<p>Wiki</p>} discussion={<p>Discussion</p>}
      alsoEnjoyed={<p>Lists</p>} />
  </WorkFrame>;
}

const meta = {
  title: 'Work page/Hub/Identity and next action',
  component: Frame,
  args: { locale: 'en', action: { kind: 'part', mode: 'continue', href: workHref(`${fixture.workRef}-2`), part: 'Volume 2' } },
  parameters: { route: { pathname: workHref(fixture.workRef), search: '' } },
} satisfies Meta<FrameArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Within the first phone screen: the Work's identity, the reader's edition and progress, and the one action. */
export const PhoneFirstScreen: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole('heading', { level: 1 });
    const action = canvas.getByRole('link', { name: /^Continue/ });
    await expect(action).toHaveAttribute('href', localizedPath(workHref(`${fixture.workRef}-2`), 'en'));
    await expect(canvas.getByText('Next: Volume 2')).toBeVisible();
    // Reporting the Work is in the action column, after the shelf and the rating, and does not lead.
    const report = canvas.getByRole('link', { name: 'Report this work' });
    await expect(report).toHaveAttribute('href', expect.stringContaining('/report'));
    await expect(report.getBoundingClientRect().top).toBeGreaterThan(action.getBoundingClientRect().bottom);
    const status = canvas.getByRole('list', { name: 'Your edition' });
    await expect(status).toHaveTextContent('Your edition: Sword Art Online 1: Aincrad');
    await expect(status).toHaveTextContent('2 of 4 required parts finished');
    // Identity, status and the action all end above the fold of a 390×844 phone.
    for (const element of [heading, action, status]) {
      const box = element.getBoundingClientRect();
      await expect(box.top).toBeGreaterThanOrEqual(0);
      await expect(box.bottom).toBeLessThanOrEqual(844);
    }
    // The cover is a thumbnail beside the title, not a poster above it.
    const cover = canvasElement.querySelector('img, [data-cover]');
    if (cover) await expect(cover.getBoundingClientRect().width).toBeLessThanOrEqual(130);
    // Tabs would overflow here; "On this page" replaces them.
    await expect(canvas.queryByRole('link', { name: 'Overview' })).toBeNull();
    await noOverflow();
  },
};

export const OnThisPageMenu: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'On this page' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    const menu = canvas.getByRole('navigation', { name: 'On this page' });
    const names = within(menu).getAllByRole('link').map(link => link.textContent);
    await expect(names).toEqual(['About', 'Your edition and availability', 'Parts and connections', 'Explore the wiki',
      'Ratings and reviews', 'Discussion and communities', 'Lists and discovery', 'Contents', 'Versions', 'Discussion',
      'History']);
    await expect(within(menu).getByRole('link', { name: 'Parts and connections' }))
      .toHaveAttribute('href', localizedPath(`${workHref(fixture.workRef)}#parts`, 'en'));
    // A story page has nowhere to go: follow the link's click without leaving it.
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener('click', stay);
    await userEvent.click(within(menu).getByRole('link', { name: 'Explore the wiki' }));
    document.removeEventListener('click', stay);
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  },
};

/** Wide screens keep tabs and a narrow rail with the action under the cover. */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.queryByRole('button', { name: 'On this page' })).toBeNull();
    const rail = canvas.getByRole('link', { name: /^Continue/ }).getBoundingClientRect();
    const title = canvas.getByRole('heading', { level: 1 }).getBoundingClientRect();
    // The action sits in the rail, beside the main column rather than under it.
    await expect(rail.right).toBeLessThanOrEqual(title.left + 1);
  },
};

export const ChooseRelease: Story = {
  args: { action: { kind: 'choose', href: '#availability', part: null } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Choose release' })).toHaveAttribute('href', '#availability');
  },
};

export const NoNextAction: Story = {
  args: { action: null },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    // Without anything of Main's to lead with, the frame's own link to Contents leads and nothing is invented.
    await expect(within(canvasElement).getByRole('link', { name: 'Read' })).toHaveAttribute('href',
      localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
  },
};

export const Japanese: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /^続ける/ })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'このページの内容' })).toBeVisible();
    await noOverflow();
  },
};

export const ChineseDark: Story = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /^繼續/ })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '本頁內容' })).toBeVisible();
    await noOverflow();
  },
};

interface EditionArgs { locale: UiLocale }

/** The edition choice against an in-memory Main: pick the audiobook, save, and see the choice kept. */
function Choice({ locale }: EditionArgs) {
  const [main] = useState(() => createMemoryMain({ editions: tracking.editions }));
  const [actions] = useState(() => memoryReader(main, {}));
  return <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <PageContainer className="max-w-xl">
      <YourEdition work={tracking.saoOne} signInHref="/auth/start" locale={locale} messages={messages[locale]} />
    </PageContainer>
  </ReaderActionsProvider>;
}

export const EditionChoice: StoryObj<Meta<EditionArgs>> = {
  render: ({ locale }) => <Choice locale={locale} />,
  args: { locale: 'en' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('combobox', { name: 'Edition' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Sword Art Online 1 (audiobook)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save choice' }));
    await expect(await canvas.findByText('Saved.')).toBeVisible();
  },
};
