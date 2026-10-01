import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { messages } from '../library/messages.ts';
import ko from '../library/messages/ko.ts';
import { assembleFiles } from './export-job.ts';
import { exportRow, fakeExportApi } from './export-fixtures.ts';
import { type ExportStore, memoryExportStore } from './export-store.ts';
import { LibraryExport } from './library-export.tsx';

const agent = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000099';

function Harness({ total = 45, failAt, moved, seed, ...props }: Partial<React.ComponentProps<typeof LibraryExport>>
  & { total?: number; failAt?: number; moved?: boolean; seed?: (store: ExportStore) => Promise<void> }) {
  const [api] = useState(() => fakeExportApi(total, { failAt, moved }).api);
  const [store] = useState(() => { const held = memoryExportStore(); void seed?.(held); return held; });
  return <LibraryExport agent={agent} locale="en" messages={messages} api={api} store={store} {...props} />;
}
const meta = { title: 'Library/Export', component: Harness, args: { save: fn() },
  parameters: { route: { pathname: '/en/library' } } } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
const open = (canvasElement: HTMLElement) => { const canvas = within(canvasElement); return userEvent.click(canvas.getByText('Download your library')).then(() => canvas); };

/** The page says what the file holds and never holds; the file is offered after the pages add up. */
export const Download: Story = { async play({ canvasElement, args }) {
  const canvas = await open(canvasElement);
  await expect(canvas.getByText(/never contains book text/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Download library' }));
  await expect(await canvas.findByText(/Your file is ready: 45 records/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Save file' }));
  const files = (args.save as ReturnType<typeof fn>).mock.calls[0]![0] as ReturnType<typeof assembleFiles>;
  await expect(files).toHaveLength(1);
  await expect(JSON.parse(files[0]!.text)).toMatchObject({ profile: 'rezics-library-export-v1', rows: expect.any(Array) });
  await expect(JSON.parse(files[0]!.text).rows).toHaveLength(45);
} };

/** A page failed half way: the position is kept, and Resume asks only for the pages that remain. */
export const Interrupted: Story = { args: { failAt: 20 }, async play({ canvasElement }) {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Download library' }));
  await expect(await canvas.findByText(/stopped after 20 records/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Resume download' }));
  await expect(await canvas.findByText(/Your file is ready: 45 records/)).toBeVisible();
} };

/** The browser reloaded mid-download: the stored position is offered instead of starting over. */
export const ResumeAfterReload: Story = { args: { seed: async store => {
  await store.append(agent, { snapshot: 'snapshot-1', cursor: 'cursor-20', pages: 1, rows: 20, done: false },
    Array.from({ length: 20 }, (_, index) => exportRow(index)));
} }, async play({ canvasElement }) {
  const canvas = await open(canvasElement);
  await expect(await canvas.findByText(/stopped after 20 records/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Resume download' }));
  await expect(await canvas.findByText(/Your file is ready: 45 records/)).toBeVisible();
} };

/** The library changed while the download was stopped: Main refuses to mix states, so the reader starts over. */
export const LibraryChanged: Story = { args: { moved: true, seed: async store => {
  await store.append(agent, { snapshot: 'snapshot-1', cursor: 'cursor-20', pages: 1, rows: 20, done: false },
    Array.from({ length: 20 }, (_, index) => exportRow(index)));
} }, async play({ canvasElement }) {
  const canvas = await open(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Resume download' }));
  await expect(await canvas.findByText(/library changed or this download expired/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Start over' }));
  await waitFor(() => expect(canvas.queryByText(/Your file is ready/)).toBeNull());
} };

export const Phone: Story = { globals: { viewport: { value: 'phone' } }, args: { total: 30 }, async play({ canvasElement }) {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Download library' }));
  await expect(await canvas.findByText(/Your file is ready: 30 records/)).toBeVisible();
} };

export const Korean: Story = { args: { locale: 'ko', messages: { ...messages, ...ko } }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await userEvent.click(within(canvasElement).getByRole('heading', { name: '서재 내려받기' })); } };
