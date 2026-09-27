import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from './field.tsx';
import { Switch } from './switch.tsx';

const meta = {
  title: 'Rezics UI/Switch',
  component: Switch,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'An on/off setting that takes effect immediately. In REZICS use it for preferences such as blurring spoilers, email digests for followed Realms, or a moderator’s “slow mode” toggle. Always pair it with a visible label; use a Checkbox when the change waits for a form submit.',
      },
    },
  },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field orientation="horizontal" className="w-fit">
      <Switch {...args} />
      <FieldLabel>Blur spoilers in reviews</FieldLabel>
    </Field>
  ),
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const toggle = within(canvasElement).getByRole('switch', { name: 'Blur spoilers in reviews' });
    await expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
    await userEvent.keyboard(' ');
    await expect(toggle).not.toBeChecked();
  },
};

export const Checked: Story = { args: { defaultChecked: true } };

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field className="w-fit" key={size} orientation="horizontal">
          <Switch defaultChecked size={size} />
          <FieldLabel>Size {size}</FieldLabel>
        </Field>
      ))}
    </div>
  ),
};

export const WithDescription: Story = {
  render: (args) => (
    <Field className="max-w-md" orientation="horizontal">
      <FieldContent>
        <FieldLabel>Slow mode in 科幻 Realm</FieldLabel>
        <FieldDescription>
          Members can post once every ten minutes while a new 《三体》 adaptation episode airs.
        </FieldDescription>
      </FieldContent>
      <Switch {...args} />
    </Field>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Field className="w-fit" disabled orientation="horizontal">
        <Switch />
        <FieldLabel>Email digest (verify your email first)</FieldLabel>
      </Field>
      <Field className="w-fit" disabled orientation="horizontal">
        <Switch defaultChecked />
        <FieldLabel>Show reading activity to followers</FieldLabel>
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    for (const toggle of within(canvasElement).getAllByRole('switch')) {
      await expect(toggle).toBeDisabled();
    }
  },
};

export const Invalid: Story = {
  render: (args) => (
    <Field className="max-w-md" invalid orientation="horizontal">
      <Switch {...args} />
      <FieldContent>
        <FieldLabel>Publish this shelf</FieldLabel>
        <FieldError>Add at least one Work before publishing the shelf.</FieldError>
      </FieldContent>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('switch')).toBeInvalid();
  },
};

export const Chinese: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Field className="w-fit" orientation="horizontal">
        <Switch defaultChecked />
        <FieldLabel>隐藏剧透（Hide spoilers）</FieldLabel>
      </Field>
      <Field className="max-w-xs" orientation="horizontal">
        <Switch />
        <FieldLabel>
          当《银河英雄传说》有新的讨论帖时通知我，并在每日摘要中包含 Realm 精选
        </FieldLabel>
      </Field>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex flex-col gap-4">
      <Field className="w-fit" orientation="horizontal">
        <Switch />
        <FieldLabel>Blur spoilers in reviews</FieldLabel>
      </Field>
      <Field className="w-fit" orientation="horizontal">
        <Switch defaultChecked />
        <FieldLabel>Email digest</FieldLabel>
      </Field>
      <Field className="w-fit" invalid orientation="horizontal">
        <Switch />
        <FieldLabel>Publish this shelf</FieldLabel>
      </Field>
      <Field className="w-fit" disabled orientation="horizontal">
        <Switch defaultChecked />
        <FieldLabel>Show reading activity</FieldLabel>
      </Field>
    </div>
  ),
};
