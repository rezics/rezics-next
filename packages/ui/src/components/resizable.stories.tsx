import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Resizable, ResizablePanel, ResizableResizeTrigger } from './resizable.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Layout/Resizable',
  component: Resizable,
  tags: ['autodocs'],
  decorators: [surface],
  args: {
    panels: [
      { id: 'contents', minSize: 20 },
      { id: 'reader', minSize: 40 },
    ],
    defaultSize: [30, 70],
  },
  parameters: {
    docs: {
      description: {
        component:
          "Panels with draggable dividers for desktop tools: the reader's table of contents beside the text, a moderation queue beside the case, or a Work edit beside its preview. Each divider is a keyboard-operable `separator`; arrow keys resize, `Home` and `End` jump to the limits. Name each divider with `aria-label` for the panels it separates. On phones, stack the panels instead.",
      },
    },
  },
} satisfies Meta<typeof Resizable>;
export default meta;
type Story = StoryObj<typeof meta>;

const Pane = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('flex h-full flex-col gap-2 p-4 text-sm', className)}>{children}</div>
);

export const Horizontal: Story = {
  render: (args) => (
    <div className="h-72 max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card">
      <Resizable {...args}>
        <ResizablePanel id="contents">
          <Pane className="bg-secondary/40">
            <p className="font-medium">Contents</p>
            <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
              <li>Anarres</li>
              <li>Urras</li>
              <li>Anarres</li>
            </ol>
          </Pane>
        </ResizablePanel>
        <ResizableResizeTrigger aria-label="Resize contents and reader" id="contents:reader" />
        <ResizablePanel id="reader">
          <Pane>
            <p className="font-heading text-lg">The Dispossessed</p>
            <p className="leading-relaxed">
              There was a wall. It did not look important. It was built of uncut rocks roughly
              mortared.
            </p>
          </Pane>
        </ResizablePanel>
      </Resizable>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const divider = canvas.getByRole('separator', { name: 'Resize contents and reader' });
    await expect(divider).toHaveAttribute('aria-valuenow', '30');
    await waitFor(
      async () => {
        divider.focus();
        await userEvent.keyboard('{ArrowRight}');
        await expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(30);
      },
      { timeout: 3000 },
    );
    await waitFor(
      async () => {
        divider.focus();
        await userEvent.keyboard('{Home}');
        await expect(divider).toHaveAttribute('aria-valuenow', '20');
      },
      { timeout: 3000 },
    );
  },
};

export const WithHandle: Story = {
  render: (args) => (
    <div className="h-72 max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card">
      <Resizable {...args}>
        <ResizablePanel id="contents">
          <Pane className="bg-secondary/40">Moderation queue · 14 open cases</Pane>
        </ResizablePanel>
        <ResizableResizeTrigger
          aria-label="Resize queue and case"
          id="contents:reader"
          withHandle
        />
        <ResizablePanel id="reader">
          <Pane>Case MOD-2026-0413: spoilers in a review of Death's End</Pane>
        </ResizablePanel>
      </Resizable>
    </div>
  ),
};

export const Vertical: Story = {
  args: {
    orientation: 'vertical',
    panels: [{ id: 'edit' }, { id: 'preview' }],
    defaultSize: [50, 50],
  },
  render: (args) => (
    <div className="h-80 max-w-md overflow-hidden rounded-2xl border border-border/60 bg-card">
      <Resizable {...args}>
        <ResizablePanel id="edit">
          <Pane>Edit: synopsis of The Dispossessed</Pane>
        </ResizablePanel>
        <ResizableResizeTrigger aria-label="Resize edit and preview" id="edit:preview" withHandle />
        <ResizablePanel id="preview">
          <Pane className="bg-secondary/40">Preview</Pane>
        </ResizablePanel>
      </Resizable>
    </div>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: (args) => (
    <div
      className="h-60 max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card"
      lang="zh-CN"
    >
      <Resizable {...args}>
        <ResizablePanel id="contents">
          <Pane className="bg-secondary/40">目录：科学边界、台球、射手和农场主……</Pane>
        </ResizablePanel>
        <ResizableResizeTrigger aria-label="调整目录与正文宽度" id="contents:reader" withHandle />
        <ResizablePanel id="reader">
          <Pane>
            <p className="font-heading text-lg">《三体》</p>
            <p>汪淼觉得，来找他的这四个人是一个奇怪的组合。</p>
          </Pane>
        </ResizablePanel>
      </Resizable>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: WithHandle.render,
};
