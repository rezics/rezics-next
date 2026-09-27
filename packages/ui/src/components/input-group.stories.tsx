import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckIcon, CopyIcon, LinkIcon, SearchIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Field, FieldError, FieldLabel } from './field.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from './input-group.tsx';
import { Kbd } from './kbd.tsx';
import { Spinner } from './spinner.tsx';

const meta = {
  title: 'Rezics UI/Input Group',
  component: InputGroup,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'An input or textarea with icons, text, keyboard hints or small buttons inside the same frame. In REZICS use it for the global and Realm search boxes, a Realm handle with its URL prefix, a copyable invite link, and the reply box with its character count and send button. The addons are decorative unless they are buttons, so the control still needs its own label.',
      },
    },
  },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-md flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <InputGroup {...args}>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search REZICS" placeholder="Search Works, Realms and people" />
      <InputGroupAddon align="inline-end">
        <Kbd>/</Kbd>
      </InputGroupAddon>
    </InputGroup>
  ),
} satisfies Meta<typeof InputGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Search: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvasElement.querySelector('[data-align=inline-end]') as HTMLElement);
    const input = canvas.getByRole('textbox', { name: 'Search REZICS' });
    await expect(input).toHaveFocus();
    await userEvent.type(input, '三体');
    await expect(input).toHaveValue('三体');
  },
};

export const Sizes: Story = {
  render: () => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <InputGroup key={size} size={size}>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={`Search (${size})`}
            placeholder={`Search, size ${size}`}
            size={size}
          />
        </InputGroup>
      ))}
    </>
  ),
};

export const WithPrefix: Story = {
  render: () => (
    <Field>
      <FieldLabel>Realm address</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>rezics.com/r/</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="scifi" />
      </InputGroup>
    </Field>
  ),
};

const CopyInvite = () => {
  const [copied, setCopied] = useState(false);
  return (
    <Field>
      <FieldLabel>Invite link</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <LinkIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput readOnly value="https://rezics.com/r/scifi/invite/7Q2K" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={copied ? 'Copied' : 'Copy invite link'}
            onClick={() => setCopied(true)}
            size="icon-xs"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
};

export const WithButton: Story = {
  render: () => <CopyInvite />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Copy invite link' }));
    await expect(canvas.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  },
};

export const Loading: Story = {
  render: () => (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search REZICS" defaultValue="银河英雄传说" />
      <InputGroupAddon align="inline-end">
        <Spinner aria-label="Searching" role="status" />
      </InputGroupAddon>
    </InputGroup>
  ),
};

const Reply = () => {
  const [text, setText] = useState('');
  return (
    <Field>
      <FieldLabel>Reply to @redcoast</FieldLabel>
      <InputGroup>
        <InputGroupTextarea
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          placeholder="Be kind. Mark spoilers with ||spoiler||."
          value={text}
        />
        <InputGroupAddon align="block-end" className="border-t">
          <InputGroupText className="tabular-nums">{text.length}/500</InputGroupText>
          <InputGroupButton
            className="ms-auto"
            disabled={text.length === 0}
            size="sm"
            variant="default"
          >
            <SendIcon aria-hidden />
            Reply
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
};

export const WithTextarea: Story = {
  render: () => <Reply />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Reply' })).toBeDisabled();
    await userEvent.type(canvas.getByRole('textbox'), '《黑暗森林》更好看');
    await expect(canvas.getByText('9/500')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Reply' })).toBeEnabled();
  },
};

export const Invalid: Story = {
  render: () => (
    <Field invalid>
      <FieldLabel>Realm address</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>rezics.com/r/</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="sci fi!" />
      </InputGroup>
      <FieldError>Use lowercase letters, numbers and hyphens only.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox')).toBeInvalid();
  },
};

export const Disabled: Story = {
  render: () => (
    <Field disabled>
      <FieldLabel>Realm address</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>rezics.com/r/</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="scifi" />
      </InputGroup>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox')).toBeDisabled();
  },
};

export const LongContent: Story = {
  render: () => (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search REZICS"
        defaultValue="Remembrance of Earth’s Past trilogy 地球往事三部曲 including Death’s End 死神永生 fan translations"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText>1,284 results</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {WithPrefix.render?.(args, context)}
      {Invalid.render?.(args, context)}
      <Reply />
    </>
  ),
};
