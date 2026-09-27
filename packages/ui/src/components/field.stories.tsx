import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Checkbox } from './checkbox.tsx';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldHelper,
  FieldLabel,
  FieldLegend,
  FieldRequiredIndicator,
  FieldSeparator,
  FieldSet,
  FieldSetHelper,
} from './field.tsx';
import { Input } from './input.tsx';
import { Switch } from './switch.tsx';
import { Textarea } from './textarea.tsx';

const meta = {
  title: 'Rezics UI/Field',
  component: Field,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Wires a label, helper text, error text and a required mark to one form control, including ids and `aria-*` links, and passes `disabled`, `invalid`, `readOnly` and `required` down to it. In REZICS every form control (Work editor, Realm settings, review form, report dialog) sits in a Field; FieldSet and FieldLegend group related Fields, and FieldGroup stacks them with consistent spacing.',
      },
    },
  },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="max-w-lg">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field {...args}>
      <FieldLabel>Work title</FieldLabel>
      <Input placeholder="e.g. The Three-Body Problem" />
      <FieldHelper>Use the title as printed on the edition you are adding.</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Work title' });
    await expect(input).toHaveAccessibleDescription(/as printed on the edition/);
    await userEvent.click(canvasElement.querySelector('label') as HTMLLabelElement);
    await expect(input).toHaveFocus();
  },
};

export const Required: Story = {
  args: { required: true },
  render: (args) => (
    <Field {...args}>
      <FieldLabel>
        Original title <FieldRequiredIndicator />
      </FieldLabel>
      <Input defaultValue="三体" />
      <FieldHelper>The title in the original language and script.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('textbox', { name: /Original title/ }),
    ).toBeRequired();
  },
};

export const Invalid: Story = {
  args: { invalid: true },
  render: (args) => (
    <Field {...args}>
      <FieldLabel>ISBN-13</FieldLabel>
      <Input defaultValue="978-0-7653-8203" />
      <FieldError>An ISBN-13 has 13 digits; this one has 12.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'ISBN-13' });
    await expect(input).toBeInvalid();
    await expect(input).toHaveAccessibleErrorMessage(/13 digits/);
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Field {...args}>
      <FieldLabel>Realm handle</FieldLabel>
      <Input defaultValue="scifi" />
      <FieldHelper>Handles cannot change after a Realm has 1,000 members.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox')).toBeDisabled();
  },
};

export const Horizontal: Story = {
  render: () => (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>Blur spoilers</FieldLabel>
          <FieldDescription>
            Reviews marked as spoilers stay blurred until you tap them.
          </FieldDescription>
        </FieldContent>
        <Switch defaultChecked />
      </Field>
      <Field orientation="horizontal">
        <Checkbox />
        <FieldContent>
          <FieldLabel>Show adult Works in search</FieldLabel>
          <FieldDescription>
            Requires a verified age. <a href="#age">Learn how verification works</a>.
          </FieldDescription>
        </FieldContent>
      </Field>
    </FieldGroup>
  ),
};

export const Responsive: Story = {
  render: () => (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Display name</FieldLabel>
          <FieldDescription>Shown on your reviews and in Realms.</FieldDescription>
        </FieldContent>
        <Input className="md:max-w-56" defaultValue="Ye Wenjie" />
      </Field>
      <FieldSeparator />
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Handle</FieldLabel>
          <FieldDescription>Used in mentions, such as @redcoast.</FieldDescription>
        </FieldContent>
        <Input className="md:max-w-56" defaultValue="redcoast" />
      </Field>
    </FieldGroup>
  ),
};

export const FieldSetWithLegend: Story = {
  render: () => (
    <FieldSet>
      <FieldLegend>Edition details</FieldLegend>
      <FieldSetHelper>
        Only the fields that differ from the first edition are required.
      </FieldSetHelper>
      <FieldGroup>
        <Field>
          <FieldLabel>Translator</FieldLabel>
          <Input defaultValue="Ken Liu" />
        </Field>
        <Field>
          <FieldLabel>Publisher</FieldLabel>
          <Input defaultValue="Tor Books" />
        </Field>
        <FieldSeparator>or</FieldSeparator>
        <Field>
          <FieldLabel>Notes for moderators</FieldLabel>
          <Textarea placeholder="Where did you find this edition?" />
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('group', { name: 'Edition details' }),
    ).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: () => (
    <FieldGroup>
      <Field required>
        <FieldLabel>
          作品名称 <FieldRequiredIndicator />
        </FieldLabel>
        <Input defaultValue="《三体》" />
        <FieldHelper>请填写原版书名，例如《银河英雄传说》。</FieldHelper>
      </Field>
      <Field invalid>
        <FieldLabel>作者 (Author)</FieldLabel>
        <Input defaultValue="" placeholder="刘慈欣 / Liu Cixin" />
        <FieldError>作者不能为空。Author is required.</FieldError>
      </Field>
    </FieldGroup>
  ),
};

export const LongContent: Story = {
  render: () => (
    <Field>
      <FieldLabel>
        Alternative titles, including romanised, translated and fan-community titles used in other
        Realms
      </FieldLabel>
      <Input defaultValue="The Three-Body Problem; Remembrance of Earth's Past; San Ti; 地球往事" />
      <FieldHelper>
        Separate titles with semicolons. Titles in any script are allowed, and search matches all of
        them, so readers who know 《地球往事》 or “Remembrance of Earth’s Past” still find this
        Work.
      </FieldHelper>
    </Field>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <FieldGroup>
      <Field required>
        <FieldLabel>
          Work title <FieldRequiredIndicator />
        </FieldLabel>
        <Input defaultValue="The Three-Body Problem" />
        <FieldHelper>Use the title as printed on the edition.</FieldHelper>
      </Field>
      <Field invalid>
        <FieldLabel>ISBN-13</FieldLabel>
        <Input defaultValue="978-0-7653-8203" />
        <FieldError>An ISBN-13 has 13 digits.</FieldError>
      </Field>
      <Field disabled>
        <FieldLabel>Realm handle</FieldLabel>
        <Input defaultValue="scifi" />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>Blur spoilers</FieldLabel>
          <FieldDescription>Reviews marked as spoilers stay blurred.</FieldDescription>
        </FieldContent>
        <Switch defaultChecked />
      </Field>
    </FieldGroup>
  ),
};
