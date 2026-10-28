import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '../shadcn/button.tsx';
import { ItemMenu } from './item-menu.tsx';
function Example() {
  const [status, setStatus] = useState('planned');
  return (
    <ItemMenu
      title="Item actions"
      backLabel="Back"
      trigger={<Button aria-label="Item actions">⋯</Button>}
      entries={[
        {
          type: 'submenu',
          label: 'Status',
          entries: [
            {
              type: 'radio',
              label: 'Status',
              value: status,
              onValueChange: setStatus,
              options: [
                { value: 'planned', label: 'Planned' },
                { value: 'done', label: 'Completed' },
              ],
            },
          ],
        },
        { type: 'separator' },
        { type: 'item', label: 'Remove', onSelect: () => {} },
      ]}
    >
      <a href="#item">A book</a>
    </ItemMenu>
  );
}
const meta = { title: 'Rezics UI/Shelf/Item menu', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ItemMenuStory: Story = {
  name: 'Item Menu',
  parameters: { viewport: { defaultViewport: 'phone' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Item actions' }));
    await expect(await within(document.body).findByText('Status')).toBeInTheDocument();
  },
};
