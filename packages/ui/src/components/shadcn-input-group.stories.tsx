import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '@rezics/ui/shadcn/input-group';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Input group',
  component: InputGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof InputGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <InputGroup className="max-w-sm">
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search Works" placeholder="Search Works" />
      <InputGroupAddon align="inline-end">
        <InputGroupText>12 results</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  ),
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Search Works' });
    // A click anywhere on an addon moves focus to the control.
    await userEvent.click(within(canvasElement).getByText('12 results'));
    await expect(input).toHaveFocus();
    await userEvent.type(input, '三体');
    await expect(input).toHaveValue('三体');
  },
};

const Copyable = () => {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroup className="max-w-sm">
      <InputGroupAddon>
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput aria-label="Shelf address" defaultValue="rezics.com/shelves/hard-sf" readOnly />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => setCopied(true)}>{copied ? 'Copied' : 'Copy'}</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
};

export const WithButton: Story = {
  render: () => <Copyable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Copy' }));
    await expect(await canvas.findByRole('button', { name: 'Copied' })).toBeVisible();
  },
};

export const Disabled: Story = {
  render: () => (
    <InputGroup className="max-w-sm" data-disabled="true">
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search Works" disabled placeholder="Search is unavailable" />
    </InputGroup>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Search Works' })).toBeDisabled();
  },
};

export const Invalid: Story = {
  render: () => (
    <div className="grid max-w-sm gap-1.5">
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>@</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Handle"
          aria-invalid="true"
          aria-describedby="handle-error"
          defaultValue="no spaces"
        />
      </InputGroup>
      <p id="handle-error" className="text-xs text-destructive">
        A handle can only use letters, digits and underscores.
      </p>
    </div>
  ),
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Handle' });
    await expect(input).toBeInvalid();
    await expect(input).toHaveAccessibleDescription(/letters, digits/);
  },
};

export const Textarea: Story = {
  render: () => (
    <InputGroup className="max-w-sm">
      <InputGroupTextarea aria-label="Review" placeholder="Write a review" />
      <InputGroupAddon align="block-end">
        <InputGroupText>2000 characters at most</InputGroupText>
        <InputGroupButton variant="default" className="ml-auto">
          Post
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const review = canvas.getByRole('textbox', { name: 'Review' });
    await userEvent.type(review, '一口氣讀完，結尾很震撼。');
    await expect(review).toHaveValue('一口氣讀完，結尾很震撼。');
    await expect(canvas.getByRole('button', { name: 'Post' })).toBeEnabled();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <InputGroup className="max-w-xs">
      <InputGroupAddon>
        <InputGroupText>書架名稱</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Shelf title"
        defaultValue="A shelf title long enough that it cannot fit in the field and has to scroll"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton>清除</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('書架名稱')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '清除' })).toBeVisible();
  },
};
