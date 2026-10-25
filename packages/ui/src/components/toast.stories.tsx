import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import { Toaster, toast } from './toast.tsx';

type ToastOptions = Parameters<typeof toast.create>[0];

// Stories keep toasts until they are dismissed so play functions and screenshots see them.
const Launcher = (props: { label: string; toasts: ToastOptions[] }) => (
  <>
    <Button
      onClick={() => {
        for (const options of props.toasts) toast.create({ duration: Infinity, ...options });
      }}
      variant="outline"
    >
      {props.label}
    </Button>
    <Toaster />
  </>
);

const meta = {
  title: 'Rezics UI/Toast',
  component: Toaster,
  tags: ['autodocs'],
  decorators: [withSurface],
  beforeEach: () => () => toast.remove(),
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 360 },
    },
  },
} satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj<typeof meta>;

const showToasts = async (canvasElement: HTMLElement, label: string, count = 1) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: label }));
  // Each toast is a status region; a loading spinner inside one is another, so match the root.
  const toasts = () => screen.getAllByRole('status').filter((el) => el.dataset.slot === 'toast');
  await waitFor(() => expect(toasts()).toHaveLength(count));
  return settled(toasts()[0] as HTMLElement);
};

export const Success: Story = {
  render: () => (
    <Launcher
      label="Mark as read"
      toasts={[
        {
          type: 'success',
          title: 'Added to Read',
          description: 'The Three-Body Problem is on your Read shelf. Rate it any time.',
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, 'Mark as read');
    await expect(status).toHaveTextContent('Added to Read');
  },
};

export const Types: Story = {
  render: () => (
    <Launcher
      label="Show all types"
      toasts={[
        {
          type: 'info',
          title: 'New revision available',
          description: 'Rev 43 of this Work was published.',
        },
        {
          type: 'warning',
          title: 'Post held for review',
          description: 'Hard SF moderators check first posts.',
        },
        {
          type: 'error',
          title: 'Couldn’t save your rating',
          description: 'Check your connection and try again.',
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    await showToasts(canvasElement, 'Show all types', 3);
  },
};

export const Loading: Story = {
  render: () => (
    <Launcher
      label="Publish revision"
      toasts={[{ type: 'loading', title: 'Publishing revision…', closable: false }]}
    />
  ),
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, 'Publish revision');
    await expect(within(status).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  },
};

const undo = fn();

export const WithAction: Story = {
  render: () => (
    <Launcher
      label="Remove from shelf"
      toasts={[
        {
          title: 'Removed from Want to read',
          description: 'The Dark Forest',
          action: { label: 'Undo', onClick: undo },
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, 'Remove from shelf');
    await userEvent.click(within(status).getByRole('button', { name: 'Undo' }));
    await expect(undo).toHaveBeenCalled();
  },
};

export const Dismiss: Story = {
  render: Success.render,
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, 'Mark as read');
    await userEvent.click(within(status).getByRole('button', { name: 'Close' }));
    await dismissed('status');
  },
};

export const LongContent: Story = {
  render: () => (
    <Launcher
      label="Import shelves"
      toasts={[
        {
          type: 'warning',
          title: 'Imported 212 of 219 Works from your Goodreads export',
          description:
            'Seven Works had no matching edition, including “Remembrance of Earth’s Past: The Three-Body Trilogy (Collector’s Box Set)”. Review them from Shelves → Import issues.',
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, 'Import shelves');
    await expect(status).toHaveTextContent(/Seven Works/);
  },
};

export const Chinese: Story = {
  render: () => (
    <Launcher
      label="加入书架"
      toasts={[
        {
          type: 'success',
          title: '已加入「想读」',
          description: '《三体》(The Three-Body Problem) 已加入你的书架。',
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    const status = await showToasts(canvasElement, '加入书架');
    await expect(status).toHaveTextContent('《三体》');
  },
};

export const Dark: Story = {
  ...Types,
  globals: { theme: 'dark' },
};
