import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from './frame.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('max-w-xl bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Layout/Frame',
  component: Frame,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A muted tray that holds one or more Aura card panels with a header and footer outside them: a settings section, a Realm rules editor, or a before/after comparison of a Work edit under review. Use it to group related panels; use Card for a single standalone surface.',
      },
    },
  },
} satisfies Meta<typeof Frame>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Frame {...args}>
      <FrameHeader description="Shown to members before they post." title="Realm rules" />
      <FramePanel>
        <ol className="list-decimal space-y-2 ps-5 text-sm">
          <li>Mark spoilers for anything past the first chapter.</li>
          <li>Review the Work, not the reviewer.</li>
          <li>No self-promotion outside the weekly thread.</li>
        </ol>
      </FramePanel>
      <FrameFooter className="flex justify-end gap-2">
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
        <Button size="sm">Save rules</Button>
      </FrameFooter>
    </Frame>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Realm rules')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save rules' })).toBeEnabled();
  },
};

export const MultiplePanels: Story = {
  name: 'Multiple panels (edit review)',
  render: () => (
    <Frame>
      <FrameHeader>
        <FrameTitle>Proposed edit to The Dispossessed</FrameTitle>
        <FrameDescription>Submitted by Mara Okafor · awaiting review</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <p className="text-muted-foreground text-xs">Current</p>
        <p className="text-sm">First published 1975</p>
      </FramePanel>
      <FramePanel>
        <p className="text-muted-foreground text-xs">Proposed</p>
        <p className="text-sm">First published May 1974 (Harper &amp; Row)</p>
      </FramePanel>
    </Frame>
  ),
};

export const PanelOnly: Story = {
  render: () => (
    <Frame>
      <FramePanel>
        <p className="text-sm">No header or footer: the tray frames a single panel.</p>
      </FramePanel>
    </Frame>
  ),
};

export const LongContent: Story = {
  name: 'Long content (zh-CN and mixed)',
  render: () => (
    <Frame lang="zh-CN">
      <FrameHeader
        description="加入前请阅读。违反规则的书评会被版主隐藏，多次违规将被移出 Realm。"
        title="硬科幻 Realm 规则 · Hard SF community guidelines"
      />
      <FramePanel>
        <p className="text-sm leading-relaxed">
          讨论《三体》《球状闪电》等作品时，请为第一章之后的情节加上剧透标记。English-language
          discussion is welcome in every thread; please keep quotes from translations attributed to
          the translator, for example Ken Liu or Joel Martinsen.
        </p>
      </FramePanel>
    </Frame>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: MultiplePanels.render,
};
