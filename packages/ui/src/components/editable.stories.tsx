import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckIcon, PencilIcon, XIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import {
  Editable,
  EditableArea,
  EditableCancelTrigger,
  EditableControl,
  EditableEditTrigger,
  EditableInput,
  EditablePreview,
  EditableSubmitTrigger,
} from './editable.tsx';

const Controls = () => (
  <EditableControl>
    <EditableEditTrigger asChild>
      <Button aria-label="Edit" size="icon-md" variant="ghost">
        <PencilIcon />
      </Button>
    </EditableEditTrigger>
    <EditableSubmitTrigger asChild>
      <Button aria-label="Save" size="icon-md" variant="soft">
        <CheckIcon />
      </Button>
    </EditableSubmitTrigger>
    <EditableCancelTrigger asChild>
      <Button aria-label="Cancel" size="icon-md" variant="ghost">
        <XIcon />
      </Button>
    </EditableCancelTrigger>
  </EditableControl>
);

const meta = {
  title: 'Rezics UI/Editable',
  component: Editable,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Text that turns into an input in place, then saves on Enter or blur and reverts on Escape. In REZICS use it for quick owner edits that do not deserve a form: renaming a shelf, a Realm’s tagline, or a caption on a reading-club post. Name the input with `translations.input`, which zag uses as its accessible name. Keep it for short text the reader owns; anything moderated or long goes through a form with a Textarea.',
      },
    },
  },
  args: {
    defaultValue: 'Hard SF I keep rereading',
    placeholder: 'Name this shelf',
    translations: { input: 'Shelf name' },
  },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-md flex-col gap-6">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Editable {...args}>
      <EditableArea>
        <EditableInput />
        <EditablePreview />
      </EditableArea>
      <Controls />
    </Editable>
  ),
} satisfies Meta<typeof Editable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit' }));
    const input = await canvas.findByRole('textbox', { name: 'Shelf name' });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    await userEvent.type(input, '三体 and friends{Enter}');
    await waitFor(() => expect(canvas.getByText('三体 and friends')).toBeVisible());
  },
};

export const Cancel: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit' }));
    const input = await canvas.findByRole('textbox', { name: 'Shelf name' });
    await userEvent.type(input, ' (draft)');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.getByText('Hard SF I keep rereading')).toBeVisible());
  },
};

export const Editing: Story = { args: { defaultEdit: true } };

export const Empty: Story = { args: { defaultValue: '' } };

export const DoubleClick: Story = {
  args: { activationMode: 'dblclick', defaultValue: 'Double-click to rename' },
  render: (args) => (
    <Editable {...args}>
      <EditableArea>
        <EditableInput />
        <EditablePreview variant="ghost" />
      </EditableArea>
    </Editable>
  ),
};

export const Vertical: Story = {
  args: {
    orientation: 'vertical',
    defaultEdit: true,
    defaultValue: 'Books that made me love space',
  },
};

export const Disabled: Story = { args: { disabled: true } };

export const LongContent: Story = {
  args: {
    defaultValue:
      'Everything in the Remembrance of Earth’s Past universe, including 《球状闪电》 and the fan-translated side stories I still need to finish',
  },
};

export const Chinese: Story = {
  args: {
    defaultValue: '《三体》及同类硬科幻',
    placeholder: '为书架命名',
    translations: { input: '书架名称' },
  },
  render: (args) => (
    <Editable {...args}>
      <EditableArea>
        <EditableInput />
        <EditablePreview />
      </EditableArea>
      <Controls />
    </Editable>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args) => (
    <>
      {meta.render(args)}
      {meta.render({ ...args, defaultEdit: true, defaultValue: 'Books that made me love space' })}
    </>
  ),
};
