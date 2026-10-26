import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Toaster, createToastManager, useToastManager } from '@rezics/ui/shadcn/toast';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Toast',
  component: Toaster,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 360 } } },
} satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj<typeof meta>;

type Options = Parameters<ReturnType<typeof useToastManager>['add']>[0];

const Trigger = ({ label, options }: { label: string; options: Options }) => {
  const manager = useToastManager();
  return <Button onClick={() => manager.add(options)}>{label}</Button>;
};

const Example = ({ label, options }: { label: string; options: Options }) => (
  <Toaster toastManager={createToastManager()} timeout={0}>
    <Trigger label={label} options={options} />
  </Toaster>
);

const toastItem = () => screen.findByRole('dialog');

export const Default: Story = {
  render: () => (
    <Example
      label="Save shelf"
      options={{ title: 'Shelf saved', description: 'Your changes are visible to followers.' }}
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Save shelf' }));
    const toast = await settled(await toastItem());
    await expect(toast).toHaveTextContent('Shelf saved');
    await expect(toast).toHaveTextContent('visible to followers');
    // The close button leaves the accessibility tree until the stack is hovered or focused.
    await userEvent.hover(toast);
    await userEvent.click(await within(toast).findByRole('button', { name: 'Close toast' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const Types: Story = {
  render: () => (
    <Example
      label="Report error"
      options={{ title: 'Could not save', description: 'The server is unreachable.', type: 'error' }}
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Report error' }));
    const toast = await settled(await toastItem());
    await expect(toast).toHaveTextContent('Could not save');
    await expect(toast.querySelector('[data-slot="toast-icon"]')).not.toBeNull();
  },
};

export const WithAction: Story = {
  render: () => (
    <Example
      label="Remove Work"
      options={{
        title: 'Removed from shelf',
        actionProps: { children: 'Undo', onClick: () => undefined },
      }}
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Remove Work' }));
    const toast = await settled(await toastItem());
    await expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  },
};

export const LongCJKText: Story = {
  render: () => (
    <Example
      label="通知"
      options={{
        title: '《三体》第三部：死神永生与更多的长标题作品已加入书架',
        description: '文明之间的黑暗森林法则：宇宙就是一座黑暗森林，每个文明都是带枪的猎人，像幽灵般潜行于林间。',
      }}
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '通知' }));
    const toast = await settled(await toastItem());
    await expect(toast).toHaveTextContent('死神永生');
    await expect(toast.scrollWidth).toBeLessThanOrEqual(toast.clientWidth + 1);
  },
};
