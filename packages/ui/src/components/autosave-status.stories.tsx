import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AutosaveStatus, relativeTime } from './autosave-status.tsx';

const labels = {
  idle: 'No changes', unsaved: 'Unsaved changes', saving: 'Saving…', saved: 'Saved',
  offline: 'Offline — kept on this device', conflict: 'Changed elsewhere — choose a version',
  error: 'Couldn’t save', retry: 'Retry',
};
const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);

const meta = {
  title: 'Rezics UI/Autosave Status',
  component: AutosaveStatus,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: 'Where an autosaved draft stands, in words a writer knows: saving, "Saved · 2 min ago", '
          + 'offline with the text kept on the device, changed elsewhere, or a failed save with Retry. '
          + 'It is a polite live region; put it in the editor footer or toolbar.',
      },
    },
  },
  args: { state: 'saved', savedAt: twoMinutesAgo, labels, locale: 'en' },
  decorators: [Story => <div className="bg-background p-6 text-foreground"><Story /></div>],
} satisfies Meta<typeof AutosaveStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Saved · 2 min. ago');
  },
};

export const Saving: Story = { args: { state: 'saving' } };

export const Offline: Story = {
  args: { state: 'offline' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Offline — kept on this device');
  },
};

export const Conflict: Story = { args: { state: 'conflict' } };

export const FailedWithRetry: Story = {
  args: { state: 'error', onRetry: fn() },
  async play({ args, canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const Chinese: Story = {
  globals: { locale: 'zh-Hans' },
  args: { locale: 'zh-Hans', labels: { idle: '没有更改', unsaved: '有未保存的更改', saving: '正在保存…',
    saved: '已保存', offline: '离线 — 已保存在此设备', conflict: '其他地方有更改 — 请选择版本',
    error: '无法保存', retry: '重试' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('已保存 · 2分钟前');
  },
};

export const Dark: Story = { args: { state: 'offline' }, globals: { theme: 'dark' } };

/** Recent saves read "now"; a day or more shows the date. */
export const Times: Story = {
  async play() {
    const now = new Date('2026-09-28T12:00:00Z');
    await expect(relativeTime(new Date('2026-09-28T11:59:40Z'), now, 'en')).toBe('now');
    await expect(relativeTime(new Date('2026-09-28T10:00:00Z'), now, 'en')).toBe('2 hr. ago');
  },
};
