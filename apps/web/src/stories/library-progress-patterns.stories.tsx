import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { userEvent, within } from 'storybook/test';
import { ProgressIndexPage } from '../library/progress-page';
import { ProgressSessionPage } from '../library/progress-session';
import { readProgressIndex, readProgressSession } from '../library/progress-server';
import sessions from '../kernel/recorded/library-progress-sessions.json';
import session from '../kernel/recorded/library-progress-session.json';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Patterns/Library/Progress controls',
  parameters: { layout: 'fullscreen', viewport: { options: viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const subjectId = sessions.progressSessions[0]!.subjectId;
const sessionId = session.progressSession.id;

function ProgressIndexPattern() {
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'progress-index-controls', subjectId],
    queryFn: () => readProgressIndex({ data: { subjectId } }),
  });
  return <ProgressIndexPage page={data} />;
}

function ProgressSessionPattern() {
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'progress-session-controls', sessionId],
    queryFn: () => readProgressSession({ data: { id: sessionId } }),
  });
  return <ProgressSessionPage page={data} />;
}

export const UnitSelectorOpen: Story = {
  name: 'Unit selector open',
  globals: { viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: m.library_progress_heading() });
    await userEvent.click(await view.findByRole('button', { name: m.library_progress_unit() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await dialog.findByRole('radiogroup', { name: m.library_progress_unit() });
  },
  render: () => (
    <PatternStory visitor="Signed In" path={pagePaths['library-progress']}>
      <Suspense fallback={null}>
        <div className="w-full max-w-4xl p-4">
          <ProgressIndexPattern />
        </div>
      </Suspense>
    </PatternStory>
  ),
};

export const UpdateFormOpen: Story = {
  name: 'Update form open',
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: m.library_progress_heading() });
    await userEvent.click(await view.findByRole('button', { name: m.library_progress_update() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await dialog.findByRole('textbox', { name: m.library_progress_locator() });
  },
  render: () => (
    <PatternStory visitor="Signed In" path={pagePaths['library-progress-session']}>
      <Suspense fallback={null}>
        <div className="w-full max-w-4xl p-4">
          <ProgressSessionPattern />
        </div>
      </Suspense>
    </PatternStory>
  ),
};
