import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ArrowBigDownIcon,
  ArrowBigUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
} from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from './button-group.tsx';
import { Input } from './input.tsx';

const meta = {
  title: 'Rezics UI/Button Group',
  component: ButtonGroup,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Joins related buttons, text or an input into one control with shared borders. In REZICS use it for split actions such as “Want to read” with a shelf menu, previous/next chapter navigation, a Realm search box with its submit button, and the vote group on post cards. Give the group an `aria-label` when its purpose is not obvious from the buttons.',
      },
    },
  },
  args: { 'aria-label': 'Chapter navigation' },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="flex min-h-32 flex-col items-start gap-6 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="outline">
        <ChevronLeftIcon aria-hidden />
        Chapter 11
      </Button>
      <Button variant="outline">
        Chapter 13
        <ChevronRightIcon aria-hidden />
      </Button>
    </ButtonGroup>
  ),
} satisfies Meta<typeof ButtonGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('group', { name: 'Chapter navigation' })).toBeInTheDocument();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Chapter 11' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Chapter 13' })).toHaveFocus();
  },
};

export const SplitButton: Story = {
  args: { 'aria-label': 'Shelve 《三体》' },
  render: (args) => (
    <ButtonGroup {...args}>
      <Button>Want to read</Button>
      <ButtonGroupSeparator className="bg-primary-foreground/30" />
      <Button aria-label="Choose another shelf" size="icon-md">
        <ChevronDownIcon />
      </Button>
    </ButtonGroup>
  ),
};

export const VoteGroup: Story = {
  args: { 'aria-label': 'Vote on this post' },
  render: (args) => (
    <ButtonGroup {...args}>
      <Button aria-label="Upvote" size="icon-sm" variant="secondary">
        <ArrowBigUpIcon />
      </Button>
      <ButtonGroupText className="h-8 border-0 bg-secondary px-1 text-foreground tabular-nums">
        1.2k
      </ButtonGroupText>
      <Button aria-label="Downvote" size="icon-sm" variant="secondary">
        <ArrowBigDownIcon />
      </Button>
    </ButtonGroup>
  ),
};

export const WithInput: Story = {
  args: { 'aria-label': 'Search this Realm' },
  render: (args) => (
    <ButtonGroup {...args} className="w-full max-w-md">
      <ButtonGroupText>r/科幻</ButtonGroupText>
      <Input aria-label="Search posts" placeholder="Search posts, e.g. 《三体》 translation" />
      <Button aria-label="Search" size="icon-md" variant="outline">
        <SearchIcon />
      </Button>
    </ButtonGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Search posts' }), '黑暗森林');
    await expect(canvas.getByRole('textbox', { name: 'Search posts' })).toHaveValue('黑暗森林');
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical', 'aria-label': 'Reading position' },
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="outline">Previous chapter</Button>
      <Button variant="outline">Table of contents</Button>
      <Button variant="outline">Next chapter</Button>
    </ButtonGroup>
  ),
};

export const Nested: Story = {
  args: { 'aria-label': 'Reader toolbar' },
  render: (args) => (
    <ButtonGroup {...args}>
      <ButtonGroup aria-label="Pages">
        <Button aria-label="Previous page" size="icon-md" variant="outline">
          <ChevronLeftIcon />
        </Button>
        <ButtonGroupText>第 12 / 48 页</ButtonGroupText>
        <Button aria-label="Next page" size="icon-md" variant="outline">
          <ChevronRightIcon />
        </Button>
      </ButtonGroup>
      <ButtonGroup aria-label="Text size">
        <Button variant="outline">A−</Button>
        <Button variant="outline">A+</Button>
      </ButtonGroup>
    </ButtonGroup>
  ),
};

export const Disabled: Story = {
  render: (args) => (
    <ButtonGroup {...args}>
      <Button disabled variant="outline">
        <ChevronLeftIcon aria-hidden />
        Prologue
      </Button>
      <Button variant="outline">
        Chapter 1
        <ChevronRightIcon aria-hidden />
      </Button>
    </ButtonGroup>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Prologue' })).toBeDisabled();
  },
};

export const LongContent: Story = {
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="outline">
        <ChevronLeftIcon aria-hidden />
        第十一章：红岸基地
      </Button>
      <Button variant="outline">
        Chapter 13: The Deterrence Era Begins
        <ChevronRightIcon aria-hidden />
      </Button>
    </ButtonGroup>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {SplitButton.render?.({ ...args, 'aria-label': 'Shelve' }, context)}
      {VoteGroup.render?.({ ...args, 'aria-label': 'Vote' }, context)}
      {WithInput.render?.({ ...args, 'aria-label': 'Search' }, context)}
    </>
  ),
};
