import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../shadcn/button.tsx';
import { Toaster } from '../shadcn/toast.tsx';
import { undoToast } from './undo-toast.tsx';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'Content/Undo toast',
  decorators: [withSurface],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example() {
  const [undos, setUndos] = useState(0);
  return (
    <Toaster>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => undoToast('Post deleted', () => setUndos((count) => count + 1))}>Delete post</Button>
        <Button onClick={() => undoToast('Review deleted', () => setUndos((count) => count + 10))}>
          Delete review
        </Button>
      </div>
      <p className="mt-4">Undo count: {undos}</p>
    </Toaster>
  );
}

const showToast = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete post' }));
  const toast = await settled(await screen.findByRole('dialog'));
  await expect(toast).toHaveTextContent('Post deleted');
  await expect(within(toast).getByRole('button', { name: 'Undo', hidden: true })).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('[aria-live=polite]')).toHaveTextContent('Post deleted'));
  return toast;
};

export const Light: Story = {
  globals: { theme: 'light' },
  render: () => <Example />,
  async play({ canvasElement }) {
    await showToast(canvasElement);
  },
};
export const Dark: Story = { ...Light, globals: { theme: 'dark' } };

export const ReplacementAndUndo: Story = {
  render: () => <Example />,
  async play({ canvasElement }) {
    await showToast(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete review' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const toast = await settled(await screen.findByRole('dialog'));
    await expect(toast).toHaveTextContent('Review deleted');
    await expect(toast).not.toHaveTextContent('Post deleted');
    await userEvent.hover(toast);
    const undo = await within(toast).findByRole('button', { name: 'Undo' });
    undo.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(within(canvasElement).getByText('Undo count: 10')).toBeVisible();
  },
};

export const Window: Story = {
  render: () => <Example />,
  async play({ canvasElement }) {
    const start = Date.now();
    const toast = await showToast(canvasElement);
    await userEvent.hover(toast);
    // Hover normally pauses shadcn's dismissal; the undo window still has a fixed deadline.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 12_000 });
    await expect(Date.now() - start).toBeGreaterThanOrEqual(8000);
    await expect(within(canvasElement).getByText('Undo count: 0')).toBeVisible();
  },
};
