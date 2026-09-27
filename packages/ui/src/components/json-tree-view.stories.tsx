import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { JsonTreeView } from './json-tree-view.tsx';

const workRecord = {
  title: '《三体》',
  titleLatin: 'The Three-Body Problem',
  language: 'zh-CN',
  publicationYear: 2008,
  ratings: { average: 4.6, count: 287 },
  moderation: { status: 'visible', reported: false },
};

const meta = {
  title: 'UI/JsonTreeView',
  component: JsonTreeView,
  tags: ['autodocs'],
  args: { data: workRecord, defaultExpandedDepth: 10 },
  parameters: {
    docs: {
      description: {
        component:
          'Use a JSON tree in REZICS maintainer and moderation tools to inspect structured Work, Realm or receipt data without flattening nested fields into an unreadable string.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main className={'aura-canvas min-h-screen bg-background p-6'}>
        <div className="mx-auto max-w-2xl rounded-2xl border border-border/60 bg-card p-5 shadow-[var(--aura-shadow-card)]">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof JsonTreeView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkRecord: Story = {
  args: { data: workRecord, defaultExpandedDepth: 10 },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tree')).toBeInTheDocument();
    await expect(canvas.getByRole('treeitem', { name: 'title: "《三体》"' })).toBeVisible();
  },
};

export const Empty: Story = {
  render: () => (
    <div className="rounded-xl border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
      No receipt details were attached to this moderation report.
    </div>
  ),
};

export const DarkMode: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="rounded-2xl bg-background p-5 text-foreground">
      <JsonTreeView data={workRecord} defaultExpandedDepth={10} />
    </div>
  ),
};
