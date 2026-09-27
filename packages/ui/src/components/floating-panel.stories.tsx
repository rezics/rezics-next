import type { Meta, StoryObj } from '@storybook/react-vite';
import { NotebookPenIcon, XIcon } from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed, settled, withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  FloatingPanel,
  FloatingPanelBody,
  FloatingPanelCloseTrigger,
  FloatingPanelContent,
  FloatingPanelControl,
  FloatingPanelFooter,
  FloatingPanelHeader,
  FloatingPanelMaximize,
  FloatingPanelMinimize,
  FloatingPanelRestore,
  FloatingPanelTitle,
  FloatingPanelTrigger,
} from './floating-panel.tsx';

const meta = {
  title: 'Rezics UI/Floating Panel',
  component: FloatingPanel,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: {
    defaultPosition: { x: 160, y: 80 },
    defaultSize: { width: 380, height: 380 },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A non-modal window the reader can drag, resize, minimise and maximise while the page stays usable, such as reading notes kept open beside a chapter, or a moderator’s notes while working through a report queue. It is for desktop multitasking; on phones use a drawer or a full page. Keep the title short, since it truncates in the header.',
      },
      story: { inline: false, iframeHeight: 520 },
    },
  },
} satisfies Meta<typeof FloatingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const notes = [
  'Ch. 7 — the countdown only Wang Miao can see. Compare with the “Three Body” game levels.',
  'Ch. 12 — Ye Wenjie’s reply to the Trisolaran message. The whole book turns on this.',
  'Ch. 18 — the sophon unfolding scene; check the Ken Liu translator’s note on dimensions.',
];

const ReadingNotes = (props: React.ComponentProps<typeof FloatingPanel>) => (
  <FloatingPanel {...props}>
    <FloatingPanelTrigger asChild>
      <Button variant="outline">
        <NotebookPenIcon aria-hidden />
        Reading notes
      </Button>
    </FloatingPanelTrigger>
    <FloatingPanelContent>
      <FloatingPanelHeader>
        <FloatingPanelTitle>Notes · The Three-Body Problem</FloatingPanelTitle>
        <FloatingPanelControl>
          <FloatingPanelMinimize />
          <FloatingPanelMaximize />
          <FloatingPanelRestore />
          <FloatingPanelCloseTrigger asChild>
            <Button aria-label="Close notes" size="icon-xs" variant="ghost">
              <XIcon />
            </Button>
          </FloatingPanelCloseTrigger>
        </FloatingPanelControl>
      </FloatingPanelHeader>
      <FloatingPanelBody className="text-sm">
        <ul className="flex flex-col gap-3">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </FloatingPanelBody>
      <FloatingPanelFooter>
        <Button size="sm">Add note</Button>
      </FloatingPanelFooter>
    </FloatingPanelContent>
  </FloatingPanel>
);

const openPanel = async (canvasElement: HTMLElement, name: RegExp | string = /Reading notes/) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('dialog'));
};

export const Default: Story = {
  render: (args) => <ReadingNotes {...args} />,
  async play({ canvasElement }) {
    const panel = await openPanel(canvasElement);
    await expect(panel).toHaveAccessibleName('Notes · The Three-Body Problem');
    // Non-modal: the page behind stays interactive.
    await expect(
      within(canvasElement).getByRole('button', { name: /Reading notes/ }),
    ).toBeEnabled();
  },
};

export const Minimized: Story = {
  render: (args) => <ReadingNotes {...args} />,
  async play({ canvasElement }) {
    const panel = await openPanel(canvasElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Minimize' }));
    await waitFor(() => expect(panel).toHaveAttribute('data-minimized'));
    await expect(within(panel).getByRole('button', { name: 'Restore' })).toBeVisible();
  },
};

export const Maximized: Story = {
  render: (args) => <ReadingNotes {...args} />,
  async play({ canvasElement }) {
    const panel = await openPanel(canvasElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Maximize' }));
    await waitFor(() => expect(panel).toHaveAttribute('data-maximized'));
  },
};

export const Close: Story = {
  render: (args) => <ReadingNotes {...args} />,
  async play({ canvasElement }) {
    const panel = await openPanel(canvasElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Close notes' }));
    await dismissed('dialog');
  },
};

export const Chinese: Story = {
  render: (args) => (
    <FloatingPanel {...args}>
      <FloatingPanelTrigger asChild>
        <Button variant="outline">版主笔记</Button>
      </FloatingPanelTrigger>
      <FloatingPanelContent>
        <FloatingPanelHeader>
          <FloatingPanelTitle>版主笔记 ·「科幻」Realm 举报队列</FloatingPanelTitle>
          <FloatingPanelControl>
            <FloatingPanelMinimize />
            <FloatingPanelCloseTrigger asChild>
              <Button aria-label="关闭" size="icon-xs" variant="ghost">
                <XIcon />
              </Button>
            </FloatingPanelCloseTrigger>
          </FloatingPanelControl>
        </FloatingPanelHeader>
        <FloatingPanelBody className="text-sm">
          举报 #1207：《三体》第 12 章剧透未加标签。已提醒作者补充剧透标记，24 小时后复查。
        </FloatingPanelBody>
      </FloatingPanelContent>
    </FloatingPanel>
  ),
  async play({ canvasElement }) {
    const panel = await openPanel(canvasElement, '版主笔记');
    await expect(within(panel).getByText(/《三体》第 12 章/)).toBeVisible();
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
