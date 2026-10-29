import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScopeChip, type SearchScope } from './search.tsx';

const meta = { title: 'Shell/Search scope chip', component: ScopeChip, parameters: { layout: 'centered' } } satisfies Meta<typeof ScopeChip>;
export default meta;
type Story = StoryObj<typeof meta>;

const scope = (kind: SearchScope['kind'], id: string, name: string, image?: string): SearchScope => ({
  kind, id, name, ...(image ? { image } : {}),
});

export const Library: Story = { args: { scope: scope('Library', 'mine', 'Library'), onRemove: () => {} } };
export const Collection: Story = { args: { scope: scope('Collection', 'cjk', '這是一個很長的中文收藏清單名稱'), onRemove: () => {} } };
export const Realm: Story = { args: { scope: scope('Realm', 'reading-room', 'Reading Room'), onRemove: () => {} } };
export const Zone: Story = { args: { scope: scope('Zone', 'classics', 'Classics'), onRemove: () => {} } };
export const Agent: Story = { args: { scope: scope('Agent', 'reader', 'Reader'), onRemove: () => {} } };
