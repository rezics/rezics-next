import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PublishedLogPageView } from '../library/log-page';
import { readPublishedLog } from '../library/logs-server';
import { setHoldingsLogStory } from '../kernel/fake/library-holdings-history';
import recording from '../kernel/recorded/library-published-log.json';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Library/Published log',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Owner delete confirmation, receipt Undo, restore and restore-refused outcomes are constructed consumer examples of the existing published-log action lifecycle inside PatternStory plus the shared AppShell at the public-log path. They are not the actual /logs/$id route, native owner authorization or recorded deletion. Signed-in and signed-out public reading stay on library-log. Keyboard, visual and native provenance remain unmeasured.',
      },
    },
  },
  beforeEach() {
    setHoldingsLogStory(true);
    return () => setHoldingsLogStory(false);
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function LogPattern() {
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'retained-log'],
    queryFn: () => readPublishedLog({ data: { id: recording.publishedLog.id } }),
  });
  return <PublishedLogPageView {...data} />;
}
function renderLog() {
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-log']}>
      <AppShell>
        <Suspense fallback={null}>
          <LogPattern />
        </Suspense>
      </AppShell>
    </PatternStory>
  );
}
async function logMain(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('main'));
}
async function remove(canvasElement: HTMLElement) {
  const view = await logMain(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.library_logs_delete() }));
  await userEvent.click(await view.findByRole('button', { name: m.library_logs_confirm_delete() }));
  await view.findByText(m.library_logs_deleted());
}
export const Snapshot: Story = {
  render: renderLog,
  play: async ({ canvasElement }) => {
    await (await logMain(canvasElement)).findByText(recording.publishedLog.note);
  },
};
export const ConfirmDelete: Story = {
  render: renderLog,
  play: async ({ canvasElement }) => {
    const view = await logMain(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.library_logs_delete() }));
    await view.findByRole('button', { name: m.library_logs_confirm_delete() });
  },
};
export const Deleted: Story = {
  render: renderLog,
  play: async ({ canvasElement }) => {
    await remove(canvasElement);
    await expect((await logMain(canvasElement)).findByRole('button', { name: m.editor_undo() })).resolves.toBeVisible();
  },
};
export const Restored: Story = {
  render: renderLog,
  play: async ({ canvasElement }) => {
    await remove(canvasElement);
    const view = await logMain(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.editor_undo() }));
    await view.findByText(recording.publishedLog.note);
    await view.findByRole('button', { name: m.library_logs_delete() });
  },
};

export const RestoreRefused: Story = {
  beforeEach() {
    setHoldingsLogStory(true, true);
  },
  render: renderLog,
  play: async ({ canvasElement }) => {
    await remove(canvasElement);
    const view = await logMain(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.editor_undo() }));
    await expect(view.findByRole('alert')).resolves.toHaveTextContent(m.library_logs_write_failed());
    await view.findByText(m.library_logs_deleted());
  },
};
