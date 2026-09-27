import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Checkbox, CheckboxGroup } from './checkbox.tsx';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from './field.tsx';

const meta = {
  title: 'Rezics UI/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A two-state (or indeterminate) choice that takes effect when a form is submitted. In REZICS use it for independent opt-ins such as "Hide spoilers" on a Work page, content warnings a reader filters out, or bulk selection in moderation queues. Use a Switch instead when the choice applies immediately, and a Radio Group when only one option may be chosen.',
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
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Field orientation="horizontal">
      <Checkbox {...args} />
      <FieldLabel>Hide spoilers for 《三体》</FieldLabel>
    </Field>
  ),
  async play({ canvasElement }) {
    const checkbox = within(canvasElement).getByRole('checkbox', {
      name: 'Hide spoilers for 《三体》',
    });
    await expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
    await userEvent.keyboard(' ');
    await expect(checkbox).not.toBeChecked();
  },
};

export const CallerRole: Story = {
  render: () => (
    <Field orientation="horizontal">
      <Checkbox role="checkbox" />
      <FieldLabel>Notify me about updates</FieldLabel>
    </Field>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: 'Notify me about updates' });
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(1);
    await expect(checkbox.tagName).toBe('INPUT');
    await expect(canvasElement.querySelector('[data-slot="checkbox"]')).not.toHaveAttribute('role');
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
  },
};

export const Checked: Story = {
  args: { defaultChecked: true },
  render: Default.render,
};

export const Indeterminate: Story = {
  args: { checked: 'indeterminate' },
  render: (args) => (
    <Field orientation="horizontal">
      <Checkbox {...args} />
      <FieldLabel>Select all 24 reports in this Realm</FieldLabel>
    </Field>
  ),
  async play({ canvasElement }) {
    const checkbox = within(canvasElement).getByRole('checkbox');
    await waitFor(() => expect(checkbox).toBePartiallyChecked());
  },
};

export const WithDescription: Story = {
  render: (args) => (
    <Field className="max-w-md" orientation="horizontal">
      <Checkbox {...args} />
      <FieldContent>
        <FieldLabel>Notify me about new chapters</FieldLabel>
        <FieldDescription>
          We send one digest a day for Works on your “Currently reading” shelf.
        </FieldDescription>
      </FieldContent>
    </Field>
  ),
};

export const Disabled: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <Field disabled orientation="horizontal">
        <Checkbox {...args} />
        <FieldLabel>Show adult content (verify your age first)</FieldLabel>
      </Field>
      <Field disabled orientation="horizontal">
        <Checkbox {...args} defaultChecked />
        <FieldLabel>Follow Realm owners automatically</FieldLabel>
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    for (const checkbox of within(canvasElement).getAllByRole('checkbox')) {
      await expect(checkbox).toBeDisabled();
    }
  },
};

export const Invalid: Story = {
  render: (args) => (
    <Field className="max-w-md" invalid orientation="horizontal">
      <Checkbox {...args} />
      <FieldContent>
        <FieldLabel>I have read the Realm rules</FieldLabel>
        <FieldError>Accept the rules before posting in 科幻 Realm.</FieldError>
      </FieldContent>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('checkbox')).toBeInvalid();
  },
};

export const Group: Story = {
  render: () => (
    <FieldSet className="max-w-sm">
      <FieldLegend>Content warnings to hide</FieldLegend>
      <CheckboxGroup defaultValue={['violence']} name="warnings">
        {[
          ['violence', 'Graphic violence'],
          ['self-harm', 'Self-harm'],
          ['spoilers', 'Plot spoilers / 剧透'],
          ['ai', 'AI-generated illustrations'],
        ].map(([value, label]) => (
          <Field key={value} orientation="horizontal">
            <Checkbox value={value} />
            <FieldLabel>{label}</FieldLabel>
          </Field>
        ))}
      </CheckboxGroup>
    </FieldSet>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('checkbox', { name: 'Graphic violence' })).toBeChecked();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Plot spoilers / 剧透' }));
    await expect(canvas.getByRole('checkbox', { name: 'Plot spoilers / 剧透' })).toBeChecked();
  },
};

export const LongLabel: Story = {
  render: (args) => (
    <Field className="max-w-xs" orientation="horizontal">
      <Checkbox {...args} />
      <FieldLabel>
        Include fan translations of 《银河英雄传说》 (Legend of the Galactic Heroes) and other works
        whose rights holders have not confirmed an official English edition
      </FieldLabel>
    </Field>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex flex-col gap-3">
      <Field orientation="horizontal">
        <Checkbox />
        <FieldLabel>Hide spoilers</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox defaultChecked />
        <FieldLabel>Notify me about new chapters</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox checked="indeterminate" />
        <FieldLabel>Select all reports</FieldLabel>
      </Field>
      <Field invalid orientation="horizontal">
        <Checkbox />
        <FieldLabel>I have read the Realm rules</FieldLabel>
      </Field>
      <Field disabled orientation="horizontal">
        <Checkbox defaultChecked />
        <FieldLabel>Follow Realm owners automatically</FieldLabel>
      </Field>
    </div>
  ),
};
