import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { FieldDescription, FieldLegend, FieldSet, FieldSetError } from './field.tsx';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from './radio-group.tsx';

const reasons = [
  ['spam', 'Spam or advertising'],
  ['spoiler', 'Unmarked spoilers'],
  ['harassment', 'Harassment of another reader'],
  ['copyright', 'Pirated chapter text'],
] as const;

const meta = {
  title: 'Rezics UI/Radio Group',
  component: RadioGroup,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A set of mutually exclusive options where every choice should stay visible. In REZICS use it for short, important choices such as the reason for a moderation report, the visibility of a shelf, or a Work’s reading status in a form. For more than about five options use a Select; for view switches that apply immediately use a Segment Group.',
      },
    },
  },
  args: { defaultValue: 'spoiler', name: 'report-reason' },
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
    <RadioGroup {...args}>
      <RadioGroupLabel>Why are you reporting this review?</RadioGroupLabel>
      {reasons.map(([value, label]) => (
        <RadioGroupItem key={value} value={value}>
          {label}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  ),
} satisfies Meta<typeof RadioGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: 'Unmarked spoilers' })).toBeChecked();
    await userEvent.click(canvas.getByRole('radio', { name: 'Spam or advertising' }));
    await expect(canvas.getByRole('radio', { name: 'Spam or advertising' })).toBeChecked();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('radio', { name: 'Unmarked spoilers' })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: 'Unmarked spoilers' })).toHaveFocus();
  },
};

export const Empty: Story = {
  args: { defaultValue: undefined },
  async play({ canvasElement }) {
    for (const radio of within(canvasElement).getAllByRole('radio')) {
      await expect(radio).not.toBeChecked();
    }
  },
};

export const Horizontal: Story = {
  args: { orientation: 'horizontal', defaultValue: 'public', name: 'shelf-visibility' },
  render: (args) => (
    <RadioGroup {...args} className="flex-row flex-wrap gap-x-6">
      <RadioGroupLabel className="basis-full">Shelf visibility</RadioGroupLabel>
      <RadioGroupItem value="public">Public</RadioGroupItem>
      <RadioGroupItem value="followers">Followers</RadioGroupItem>
      <RadioGroupItem value="private">Only me</RadioGroupItem>
    </RadioGroup>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    for (const radio of within(canvasElement).getAllByRole('radio')) {
      await expect(radio).toBeDisabled();
    }
  },
};

export const DisabledItem: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      <RadioGroupLabel>Why are you reporting this review?</RadioGroupLabel>
      {reasons.map(([value, label]) => (
        <RadioGroupItem disabled={value === 'copyright'} key={value} value={value}>
          {label}
        </RadioGroupItem>
      ))}
      <FieldDescription className="ms-0">
        Copyright reports go through the rights holder form.
      </FieldDescription>
    </RadioGroup>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: undefined },
  render: (args) => (
    <FieldSet invalid>
      <FieldLegend variant="label">Why are you reporting this review?</FieldLegend>
      <RadioGroup {...args}>
        {reasons.map(([value, label]) => (
          <RadioGroupItem key={value} value={value}>
            {label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
      <FieldSetError>Choose a reason so moderators can triage the report.</FieldSetError>
    </FieldSet>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radiogroup')).toHaveAccessibleName(
      'Why are you reporting this review?',
    );
    await expect(canvas.getByText(/Choose a reason/)).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { defaultValue: 'reading', name: 'reading-status' },
  render: (args) => (
    <RadioGroup {...args}>
      <RadioGroupLabel>《三体》阅读状态</RadioGroupLabel>
      <RadioGroupItem value="want">想读</RadioGroupItem>
      <RadioGroupItem value="reading">在读 (Reading)</RadioGroupItem>
      <RadioGroupItem value="read">读过</RadioGroupItem>
      <RadioGroupItem value="dropped">弃读 · Dropped after 第二部《黑暗森林》</RadioGroupItem>
    </RadioGroup>
  ),
};

export const LongLabels: Story = {
  render: (args) => (
    <RadioGroup {...args} className="max-w-sm">
      <RadioGroupLabel>Why are you reporting this review?</RadioGroupLabel>
      <RadioGroupItem value="spoiler">
        It reveals the ending of 《球状闪电》 without a spoiler tag, even though the Realm rules
        require one for books published in the last two years
      </RadioGroupItem>
      <RadioGroupItem value="spam">Spam or advertising</RadioGroupItem>
    </RadioGroup>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <RadioGroup {...args}>
        <RadioGroupLabel>Why are you reporting this review?</RadioGroupLabel>
        {reasons.map(([value, label]) => (
          <RadioGroupItem disabled={value === 'copyright'} key={value} value={value}>
            {label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
      <RadioGroup defaultValue="spam" invalid name="report-invalid">
        <RadioGroupLabel>Invalid</RadioGroupLabel>
        <RadioGroupItem value="spam">Spam or advertising</RadioGroupItem>
        <RadioGroupItem value="spoiler">Unmarked spoilers</RadioGroupItem>
      </RadioGroup>
    </div>
  ),
};
