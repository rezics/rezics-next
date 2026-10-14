import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import type { MediaApi, WorkMark, WorkStanding } from './media-api.ts';
import { copyOf } from './messages.ts';
import { WorkProgress } from './work-progress.tsx';

function memory(initial: WorkStanding = 'not-started', stale = false): Pick<MediaApi, 'workStanding' | 'markWork'> {
  let mark: WorkMark = { standing: initial, version: initial === 'not-started' ? 0 : 1 };
  let once = stale;
  return {
    async workStanding() { return { ok: true, data: mark }; },
    async markWork(_work, standing) {
      if (once) {
        once = false;
        return { ok: false, failure: 'stale', current: mark, submitted: standing };
      }
      mark = { standing, version: mark.version + 1 };
      return { ok: true, data: mark };
    },
  };
}

function Sheet({ api }: { api: Pick<MediaApi, 'workStanding' | 'markWork'> }) {
  return <PageContainer className="grid max-w-md gap-6">
    <WorkProgress work="https://example.test/novel" api={api} verb="play" t={copyOf('en')} />
  </PageContainer>;
}

const meta = {
  title: 'Tracking/Work progress',
  component: Sheet,
  parameters: { docs: { description: { component:
    'A Work with no parts is marked as a whole: not started, playing, completed or dropped, and the mark can be taken back. Another device that wrote first is shown beside the change.' } } },
  args: { api: memory() },
  globals: { viewport: { value: 'phone' } },
} satisfies Meta<{ api: Pick<MediaApi, 'workStanding' | 'markWork'> }>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Playing, then completed, then back to not started. The phone width is the one a reader holds. */
export const MarkCompleted: Story = {
  args: { api: memory() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Not started');
    await userEvent.click(view.getByRole('button', { name: 'Mark playing' }));
    await view.findByText('Playing');
    await expect(canvasElement.querySelector('[data-play-state="playing"]')).not.toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Mark completed' }));
    await view.findByText('Completed', { exact: true });
    await userEvent.click(view.getByRole('button', { name: 'Mark not started' }));
    await view.findByText('Not started');
  },
};

/** Dropped is its own mark, and it can be taken back. */
export const Dropped: Story = {
  args: { api: memory('dropped') },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Dropped');
    await expect(canvasElement.querySelector('[data-play-state="dropped"]')).not.toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Mark not started' }));
    await view.findByText('Not started');
  },
};

/** Another device wrote first. Keeping the change applies it on the newer version. */
export const ChangedElsewhere: Story = {
  args: { api: memory('started', true) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Playing');
    await userEvent.click(view.getByRole('button', { name: 'Mark completed' }));
    await view.findByRole('alert');
    await userEvent.click(view.getByRole('button', { name: 'Keep my change' }));
    await view.findByText('Completed', { exact: true });
  },
};

let partsReads = 0;
/** A composition uses its occurrence controls; a whole-Work mark is absent, not an unavailable retry. */
export const HasParts: Story = {
  args: { api: { ...memory(), async workStanding() { partsReads++; return { ok: false, failure: 'has-parts' }; } } },
  async play({ canvasElement }) {
    await waitFor(() => expect(partsReads).toBeGreaterThan(0));
    await expect(within(canvasElement).queryByRole('alert')).not.toBeInTheDocument();
    await expect(within(canvasElement).queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument();
  },
};
