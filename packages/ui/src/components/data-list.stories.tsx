import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Badge } from './badge.tsx';
import { DataList, DataListItem, DataListItemLabel, DataListItemValue } from './data-list.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('max-w-lg bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const edition = [
  ['Author', 'Ursula K. Le Guin'],
  ['Publisher', 'Harper & Row'],
  ['First published', 'May 1974'],
  ['Pages', '387'],
  ['ISBN', '978-0-06-051275-4'],
] as const;

const meta = {
  title: 'Rezics UI/Display/Data List',
  component: DataList,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          "Label and value pairs describing one record, rendered as a `<dl>`: a Work's edition details, a Realm's settings summary, a member's profile facts or a moderation case. Use the horizontal orientation in wide panels and vertical in narrow sidebars. Use Table instead to compare several records.",
      },
    },
  },
} satisfies Meta<typeof DataList>;
export default meta;
type Story = StoryObj<typeof meta>;

const EditionList = (props: React.ComponentProps<typeof DataList>) => (
  <DataList {...props}>
    {edition.map(([label, value]) => (
      <DataListItem key={label}>
        <DataListItemLabel>{label}</DataListItemLabel>
        <DataListItemValue className={label === 'ISBN' ? 'font-mono' : undefined}>
          {value}
        </DataListItemValue>
      </DataListItem>
    ))}
  </DataList>
);

export const Horizontal: Story = {
  render: (args) => <EditionList {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('term')).toHaveLength(5);
    await expect(canvas.getAllByRole('definition')[0]).toHaveTextContent('Ursula K. Le Guin');
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => <EditionList {...args} />,
};

export const RichValues: Story = {
  render: () => (
    <DataList>
      <DataListItem>
        <DataListItemLabel>Case</DataListItemLabel>
        <DataListItemValue className="font-mono">MOD-2026-0413</DataListItemValue>
      </DataListItem>
      <DataListItem>
        <DataListItemLabel>Status</DataListItemLabel>
        <DataListItemValue>
          <Badge variant="secondary">Awaiting second moderator</Badge>
        </DataListItemValue>
      </DataListItem>
      <DataListItem>
        <DataListItemLabel>Reported content</DataListItemLabel>
        <DataListItemValue>
          <a className="text-primary underline underline-offset-4" href="#review">
            Review of Death's End by Kenji Arai
          </a>
        </DataListItemValue>
      </DataListItem>
      <DataListItem>
        <DataListItemLabel>Resolution</DataListItemLabel>
        <DataListItemValue className="text-muted-foreground">Not yet decided</DataListItemValue>
      </DataListItem>
    </DataList>
  ),
};

export const LongContent: Story = {
  name: 'Long content (zh-CN and mixed)',
  render: () => (
    <DataList lang="zh-CN">
      <DataListItem>
        <DataListItemLabel>书名</DataListItemLabel>
        <DataListItemValue>《三体》（地球往事三部曲之一）</DataListItemValue>
      </DataListItem>
      <DataListItem>
        <DataListItemLabel>作者</DataListItemLabel>
        <DataListItemValue>刘慈欣 · Liu Cixin</DataListItemValue>
      </DataListItem>
      <DataListItem>
        <DataListItemLabel>简介</DataListItemLabel>
        <DataListItemValue>
          文化大革命如火如荼进行的同时，军方探寻外星文明的绝秘计划「红岸工程」取得了突破性进展。The
          novel was translated into English by Ken Liu and won the Hugo Award for Best Novel in
          2015.
        </DataListItemValue>
      </DataListItem>
    </DataList>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => <EditionList />,
};
