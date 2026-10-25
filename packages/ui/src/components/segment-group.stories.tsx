import type { Meta, StoryObj } from '@storybook/react-vite';
import { LayoutGridIcon, ListIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from './segment-group.tsx';

const sorts = [
  ['hot', 'Hot'],
  ['new', 'New'],
  ['top', 'Top this week'],
] as const;

const meta = {
  title: 'Rezics UI/Segment Group',
  component: SegmentGroup,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A compact, single-choice switch between a few views of the same content, with a sliding indicator. In REZICS use it for sorting a Realm feed (Hot, New, Top), switching a shelf between covers and a list, or the rating scope on a Work page. It behaves like a radio group, so the choice applies immediately; use Tabs when each option shows a different panel.',
      },
    },
  },
  args: { defaultValue: 'hot', 'aria-label': 'Sort posts' },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="flex min-h-32 flex-col items-start gap-6 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <SegmentGroup {...args}>
      {sorts.map(([value, label]) => (
        <SegmentGroupItem key={value} value={value}>
          <SegmentGroupItemText>{label}</SegmentGroupItemText>
        </SegmentGroupItem>
      ))}
    </SegmentGroup>
  ),
} satisfies Meta<typeof SegmentGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: 'Hot' })).toBeChecked();
    await userEvent.click(canvas.getByText('New'));
    await expect(canvas.getByRole('radio', { name: 'New' })).toBeChecked();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('radio', { name: 'Top this week' })).toBeChecked();
  },
};

export const Underline: Story = { args: { variant: 'underline' } };

export const WithIcons: Story = {
  args: { defaultValue: 'covers', 'aria-label': 'Shelf layout' },
  render: (args) => (
    <SegmentGroup {...args}>
      <SegmentGroupItem value="covers">
        <LayoutGridIcon aria-hidden />
        <SegmentGroupItemText>Covers</SegmentGroupItemText>
      </SegmentGroupItem>
      <SegmentGroupItem value="list">
        <ListIcon aria-hidden />
        <SegmentGroupItemText>List</SegmentGroupItemText>
      </SegmentGroupItem>
    </SegmentGroup>
  ),
};

export const Vertical: Story = { args: { orientation: 'vertical' } };

export const VerticalUnderline: Story = { args: { orientation: 'vertical', variant: 'underline' } };

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
    <SegmentGroup {...args}>
      {sorts.map(([value, label]) => (
        <SegmentGroupItem disabled={value === 'top'} key={value} value={value}>
          <SegmentGroupItemText>{label}</SegmentGroupItemText>
        </SegmentGroupItem>
      ))}
    </SegmentGroup>
  ),
};

export const Chinese: Story = {
  args: { defaultValue: 'all', 'aria-label': '评分范围' },
  render: (args) => (
    <SegmentGroup {...args}>
      <SegmentGroupItem value="all">
        <SegmentGroupItemText>全部评分</SegmentGroupItemText>
      </SegmentGroupItem>
      <SegmentGroupItem value="realm">
        <SegmentGroupItemText>科幻 Realm 成员</SegmentGroupItemText>
      </SegmentGroupItem>
      <SegmentGroupItem value="following">
        <SegmentGroupItemText>我关注的人</SegmentGroupItemText>
      </SegmentGroupItem>
    </SegmentGroup>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args) => (
    <>
      {meta.render(args)}
      {meta.render({ ...args, variant: 'underline' })}
    </>
  ),
};
