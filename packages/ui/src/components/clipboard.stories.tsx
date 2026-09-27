import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import {
  Clipboard,
  ClipboardIndicator,
  ClipboardInput,
  ClipboardTrigger,
  ClipboardValue,
} from './clipboard.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-md bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const inviteLink = 'https://rezics.com/realms/hard-sf/invite/7QK2-M9ZD';

const meta = {
  title: 'Rezics UI/Display/Clipboard',
  component: Clipboard,
  tags: ['autodocs'],
  decorators: [surface],
  args: { value: inviteLink, label: 'Realm invite link' },
  parameters: {
    docs: {
      description: {
        component:
          "Copies a value with one click: a Realm invite link, a Work's permanent link, an ISBN or an API token shown once. Compose a read-only `ClipboardInput` (or `ClipboardValue` for short text) with a `ClipboardTrigger` rendering a Button, and `ClipboardIndicator` to swap the icon after copying. Give the control a `label`, and name icon-only triggers. The copied state resets after `timeout` milliseconds.",
      },
    },
  },
} satisfies Meta<typeof Clipboard>;
export default meta;
type Story = StoryObj<typeof meta>;

const onStatusChange = fn();

export const Default: Story = {
  args: { onStatusChange },
  render: (args) => (
    <Clipboard {...args}>
      <ClipboardInput />
      <ClipboardTrigger asChild>
        <Button aria-label="Copy invite link" size="icon-md" variant="outline">
          <ClipboardIndicator />
        </Button>
      </ClipboardTrigger>
    </Clipboard>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: 'Realm invite link' });
    await expect(input).toHaveValue(inviteLink);
    await expect(input).toHaveAttribute('readonly');

    // Headless browsers deny clipboard writes; stub it for the test only.
    const writeText = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    try {
      const trigger = canvas.getByRole('button', { name: 'Copy invite link' });
      await userEvent.click(trigger);
      await waitFor(() => expect(trigger).toHaveAttribute('data-copied'));
      await expect(writeText).toHaveBeenCalledWith(inviteLink);
      await expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ copied: true }));
    } finally {
      writeText.mockRestore();
    }
  },
};

export const WithTextButton: Story = {
  args: { label: 'Permanent link to this Work', value: 'https://rezics.com/w/the-dispossessed' },
  render: (args) => (
    <Clipboard {...args}>
      <ClipboardInput />
      <ClipboardTrigger asChild>
        <Button variant="soft">
          <ClipboardIndicator copied="Copied">Copy</ClipboardIndicator>
        </Button>
      </ClipboardTrigger>
    </Clipboard>
  ),
};

export const Value: Story = {
  name: 'Value (short text)',
  args: { label: undefined, value: '978-0-06-051275-4' },
  render: (args) => (
    <Clipboard {...args}>
      <span className="text-muted-foreground text-sm">ISBN</span>
      <ClipboardValue className="font-mono" size="sm" />
      <ClipboardTrigger asChild>
        <Button aria-label="Copy ISBN" size="icon-sm" variant="ghost">
          <ClipboardIndicator />
        </Button>
      </ClipboardTrigger>
    </Clipboard>
  ),
};

export const Sizes: Story = {
  args: { label: undefined, value: '978-0-06-051275-4' },
  render: (args) => (
    <div className="flex flex-col items-start gap-3">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Clipboard {...args} key={size}>
          <ClipboardValue className="font-mono" size={size} />
        </Clipboard>
      ))}
    </div>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN and long value',
  args: {
    label: '《三体》讨论帖链接',
    value: 'https://rezics.com/realms/hard-sf/posts/三体-黑暗森林-读书会-第三周-讨论-叶文洁的选择',
  },
  render: (args) => (
    <div lang="zh-CN">
      <Clipboard {...args}>
        <ClipboardInput />
        <ClipboardTrigger asChild>
          <Button aria-label="复制链接" size="icon-md" variant="outline">
            <ClipboardIndicator />
          </Button>
        </ClipboardTrigger>
      </Clipboard>
    </div>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: Default.render,
};
