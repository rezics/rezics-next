import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { BookIcon, LibraryIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  createTreeCollection,
  type TreeNodeType,
  TreeView,
  TreeViewBranch,
  TreeViewBranchContent,
  TreeViewBranchItem,
  TreeViewCheckbox,
  TreeViewContent,
  TreeViewItem,
  TreeViewLabel,
  TreeViewNode,
  TreeViewTree,
} from './tree-view.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-sm bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const genres = createTreeCollection<TreeNodeType>({
  rootNode: {
    id: 'root',
    name: 'Genres',
    children: [
      {
        id: 'sf',
        name: 'Science fiction',
        children: [
          { id: 'sf-hard', name: 'Hard science fiction' },
          { id: 'sf-space-opera', name: 'Space opera' },
          {
            id: 'sf-social',
            name: 'Social science fiction',
            children: [
              { id: 'sf-utopia', name: 'Utopian fiction' },
              { id: 'sf-dystopia', name: 'Dystopian fiction' },
            ],
          },
        ],
      },
      {
        id: 'fantasy',
        name: 'Fantasy',
        children: [
          { id: 'fantasy-portal', name: 'Portal fantasy' },
          { id: 'fantasy-wuxia', name: 'Wuxia 武侠' },
        ],
      },
      { id: 'poetry', name: 'Poetry' },
    ],
  },
});

const series = createTreeCollection<TreeNodeType>({
  rootNode: {
    id: 'root',
    name: '地球往事',
    children: [
      {
        id: 'rep',
        name: '地球往事三部曲 · Remembrance of Earth’s Past',
        children: [
          { id: 'tbp', name: '《三体》The Three-Body Problem' },
          { id: 'df', name: '《三体 II：黑暗森林》The Dark Forest' },
          { id: 'de', name: '《三体 III：死神永生》Death’s End' },
        ],
      },
      { id: 'redemption', name: '《三体 X：观想之宙》（同人续作，宝树）' },
    ],
  },
});

interface NodeProps {
  checkable?: boolean;
  indexPath: number[];
  node: TreeNodeType;
}

const TreeNode = ({ node, indexPath, checkable }: NodeProps) => (
  <TreeViewNode indexPath={indexPath} node={node}>
    {node.children ? (
      <TreeViewBranch>
        <TreeViewBranchItem expandedIcon={LibraryIcon} icon={LibraryIcon}>
          {checkable && <TreeViewCheckbox />}
          {node.name}
        </TreeViewBranchItem>
        <TreeViewBranchContent>
          {node.children.map((child, index) => (
            <TreeNode
              checkable={checkable}
              indexPath={[...indexPath, index]}
              key={child.id}
              node={child}
            />
          ))}
        </TreeViewBranchContent>
      </TreeViewBranch>
    ) : (
      <TreeViewContent>
        {checkable && <TreeViewCheckbox />}
        <TreeViewItem icon={BookIcon}>{node.name}</TreeViewItem>
      </TreeViewContent>
    )}
  </TreeViewNode>
);

const meta = {
  title: 'Rezics UI/Display/Tree View',
  component: TreeView,
  tags: ['autodocs'],
  decorators: [surface],
  args: { collection: genres },
  parameters: {
    docs: {
      description: {
        component:
          "A keyboard-navigable hierarchy for nested data: a genre taxonomy, a Work series with its volumes, or a Realm's nested reading lists. Build the data with `createTreeCollection`, render nodes recursively with `TreeViewNode`, and add `TreeViewCheckbox` for multi-select filters. Arrow keys move and expand, typeahead jumps by name. Use Accordion for a few collapsible sections of prose instead.",
      },
    },
  },
} satisfies Meta<typeof TreeView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <TreeView {...args}>
      <TreeViewLabel>Genres</TreeViewLabel>
      <TreeViewTree>
        {args.collection.rootNode.children?.map((node: TreeNodeType, index: number) => (
          <TreeNode indexPath={[index]} key={node.id} node={node} />
        ))}
      </TreeViewTree>
    </TreeView>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tree = canvas.getByRole('tree', { name: 'Genres' });
    const sf = within(tree).getByRole('treeitem', { name: 'Science fiction' });
    await expect(sf).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(within(sf).getByText('Science fiction'));
    await waitFor(() => expect(sf).toHaveAttribute('aria-expanded', 'true'));

    const hard = within(tree).getByRole('treeitem', { name: 'Hard science fiction' });
    await userEvent.click(hard);
    await expect(hard).toHaveAttribute('aria-selected', 'true');
  },
};

export const Keyboard: Story = {
  name: 'Keyboard navigation',
  render: Default.render,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tree = canvas.getByRole('tree');
    await userEvent.tab();
    const sf = within(tree).getByRole('treeitem', { name: 'Science fiction' });
    await waitFor(() =>
      expect(sf.querySelector('[data-slot="tree-view-branch-control"]')).toHaveFocus(),
    );

    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(sf).toHaveAttribute('aria-expanded', 'true'));
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(within(tree).getByRole('treeitem', { name: 'Hard science fiction' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(sf).toHaveAttribute('aria-expanded', 'false'));
  },
};

export const Expanded: Story = {
  args: { defaultExpandedValue: ['sf', 'sf-social'], defaultSelectedValue: ['sf-utopia'] },
  render: Default.render,
};

export const Checkboxes: Story = {
  name: 'Checkboxes (genre filter)',
  args: { checkable: true, defaultExpandedValue: ['sf'], defaultCheckedValue: ['sf-hard'] },
  render: (args) => (
    <TreeView {...args}>
      <TreeViewLabel>Filter by genre</TreeViewLabel>
      <TreeViewTree>
        {args.collection.rootNode.children?.map((node: TreeNodeType, index: number) => (
          <TreeNode checkable indexPath={[index]} key={node.id} node={node} />
        ))}
      </TreeViewTree>
    </TreeView>
  ),
  async play({ canvasElement }) {
    const tree = within(canvasElement).getByRole('tree', { name: 'Filter by genre' });
    const hard = within(tree).getByRole('treeitem', { name: 'Hard science fiction' });
    const space = within(tree).getByRole('treeitem', { name: 'Space opera' });
    const sf = within(tree).getByRole('treeitem', { name: /^Science fiction/ });
    await expect(hard).toHaveAttribute('aria-checked', 'true');
    await expect(sf).toHaveAttribute('aria-checked', 'mixed');

    // Clicking the visual checkbox toggles the row.
    const box = space.querySelector<HTMLElement>('[data-slot="tree-view-checkbox"]');
    await userEvent.click(box as HTMLElement);
    await waitFor(() => expect(space).toHaveAttribute('aria-checked', 'true'));

    // Space toggles the focused row without selecting it.
    space.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(space).toHaveAttribute('aria-checked', 'false'));
    await userEvent.keyboard('{ArrowUp} ');
    await waitFor(() => expect(hard).toHaveAttribute('aria-checked', 'false'));
    await expect(sf).toHaveAttribute('aria-checked', 'false');
  },
};

export const Chinese: Story = {
  name: 'zh-CN and long names',
  args: { collection: series, defaultExpandedValue: ['rep'] },
  render: (args) => (
    <TreeView lang="zh-CN" {...args}>
      <TreeViewLabel>系列作品</TreeViewLabel>
      <TreeViewTree>
        {args.collection.rootNode.children?.map((node: TreeNodeType, index: number) => (
          <TreeNode indexPath={[index]} key={node.id} node={node} />
        ))}
      </TreeViewTree>
    </TreeView>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  args: { defaultExpandedValue: ['sf', 'fantasy'], defaultSelectedValue: ['sf-hard'] },
  render: Default.render,
};
