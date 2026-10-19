import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { localizedPath } from '../../i18n/locale.ts';
import { standaloneSummary } from '../tracking/fixtures.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import type { ReadStart } from './read.ts';
import { chapterHref, workHref } from './route.ts';
import { ReadButton, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';

const href = `${chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000004')}?language=en`;

/** Component states only: genuine C28 persistence and selected-revision proof runs separately. */
function BookResume({ start }: { start: ReadStart }) {
  const t = messages.en;
  return <WorkFrame workRef={fixture.workRef} work={fixture.work} locale="en" messages={t}
    credits={<WorkCredits agentCredits={fixture.agentCredits} credits={fixture.credits} locale="en" messages={t} />}
    readAction={<ReadButton workRef={fixture.workRef} start={start} messages={t} />}
    status={<IdentityStatus start={start} progress={{ ok: true, data: {
      ...standaloneSummary('not-started'), resource: fixture.work.id,
    } }} preference={{ ok: true, data: { work: fixture.work.id, language: 'en', edition: null, version: 1 } }}
    editionName={null} locale="en" messages={t} />}>
    <WorkAbout work={fixture.work} locale="en" messages={t} />
  </WorkFrame>;
}

const meta = {
  title: 'Work page/Book chapter resume', component: BookResume,
  args: { start: { kind: 'continue', href, chapter: 'Chapter 4: Neap Tide' } },
  globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: workHref(fixture.workRef), search: '' } },
} satisfies Meta<typeof BookResume>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SavedChapter: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: messages.en.continueReadingShort }))
      .toHaveAttribute('href', localizedPath(href, 'en'));
    await expect(canvas.getByText('Chapter 4: Neap Tide')).toBeVisible();
    await expect(canvas.getByRole('list', { name: 'Your edition' })).toHaveTextContent('Your edition: English');
    await expect(canvas.queryByText(trackingCopy('en').notStarted)).not.toBeInTheDocument();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const SavedChapterDesktop: Story = { ...SavedChapter, globals: { viewport: { value: 'desktop' } } };

export const NoProgress: Story = {
  args: { start: { kind: 'start', href: chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000001'),
    chapter: 'Chapter 1: Low Water' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: messages.en.startReading })).toBeVisible();
    await expect(canvas.getByText(trackingCopy('en').notStarted)).toBeVisible();
    await expect(canvas.getByRole('list', { name: 'Your edition' })).toHaveTextContent('Your edition: English');
  },
};

export const ResumeUnavailable: Story = {
  args: { start: { kind: 'contents' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: messages.en.read }))
      .toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
    await expect(canvas.queryByRole('link', { name: messages.en.startReading })).not.toBeInTheDocument();
    await expect(canvas.queryByText(trackingCopy('en').notStarted)).not.toBeInTheDocument();
    await expect(canvas.getByRole('list', { name: 'Your edition' })).toHaveTextContent('Your edition: English');
  },
};
