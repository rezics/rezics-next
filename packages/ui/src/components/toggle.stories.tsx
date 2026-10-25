import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  BellIcon,
  BellOffIcon,
  BoldIcon,
  BookmarkIcon,
  EyeOffIcon,
  ItalicIcon,
} from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { Toggle, ToggleIndicator } from './toggle.tsx';

const meta = {
  title: 'Rezics UI/Toggle',
  component: Toggle,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A button that stays pressed until pressed again. In REZICS use it for a single reversible state on the current item: bookmarking a Work, following a Realm thread, hiding spoilers in a chapter view, or bold and italic in the review editor. Icon-only toggles need an `aria-label`. Use a Toggle Group for a set of related toggles and a Switch for settings.',
      },
    },
  },
  args: { 'aria-label': 'Bookmark 《三体》', children: <BookmarkIcon /> },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="flex min-h-32 items-start gap-3 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const toggle = within(canvasElement).getByRole('button', { name: 'Bookmark 《三体》' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Enter}');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  },
};

export const Pressed: Story = { args: { defaultPressed: true } };

export const Outline: Story = {
  render: () => (
    <>
      <Toggle aria-label="Bold" variant="outline">
        <BoldIcon />
      </Toggle>
      <Toggle aria-label="Italic" defaultPressed variant="outline">
        <ItalicIcon />
      </Toggle>
    </>
  ),
};

export const Sizes: Story = {
  render: () => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Toggle aria-label={`Bookmark (${size})`} defaultPressed key={size} size={size}>
          <BookmarkIcon />
        </Toggle>
      ))}
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Toggle key={size} size={size} variant="outline">
          <EyeOffIcon />
          Hide spoilers
        </Toggle>
      ))}
    </>
  ),
};

export const WithText: Story = {
  render: () => (
    <>
      <Toggle variant="outline">
        <EyeOffIcon />
        Hide spoilers
      </Toggle>
      <Toggle defaultPressed variant="outline">
        <EyeOffIcon />
        隐藏剧透
      </Toggle>
    </>
  ),
};

export const WithIndicator: Story = {
  render: () => (
    <Toggle variant="outline">
      <ToggleIndicator
        fallback={
          <>
            <BellIcon aria-hidden />
            Follow thread
          </>
        }
      >
        <BellOffIcon aria-hidden />
        Following
      </ToggleIndicator>
    </Toggle>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow thread' }));
    await expect(canvas.getByRole('button', { name: 'Following' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button')).toBeDisabled();
  },
};

export const LongLabel: Story = {
  render: () => (
    <div className="max-w-xs">
      <Toggle className="h-auto min-h-9 whitespace-normal py-2 text-left" variant="outline">
        <BellIcon />
        Notify me when 《银河英雄传说》 gets a new English translation chapter
      </Toggle>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <>
      <Toggle aria-label="Bookmark">
        <BookmarkIcon />
      </Toggle>
      <Toggle aria-label="Bookmarked" defaultPressed>
        <BookmarkIcon />
      </Toggle>
      <Toggle variant="outline">
        <EyeOffIcon />
        Hide spoilers
      </Toggle>
      <Toggle defaultPressed variant="outline">
        <EyeOffIcon />
        Hide spoilers
      </Toggle>
      <Toggle disabled variant="outline">
        <BoldIcon />
        Bold
      </Toggle>
    </>
  ),
};
