import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CoverCard, CoverGrid, CoverRow } from './cover-card.tsx';
import { Tombstone } from './tombstone.tsx';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'Content/Tombstone',
  component: Tombstone,
  args: { shape: 'post' },
  decorators: [withSurface],
} satisfies Meta<typeof Tombstone>;
export default meta;
type Story = StoryObj<typeof meta>;

const liveCard = (
  <CoverCard
    title="A surviving record"
    secondary="A creator"
    state="Reading"
    href="/surviving"
    cover={{
      subject: { id: 'surviving', title: 'A surviving record', types: ['schema:Book'] },
      cover: null,
      src: () => '',
    }}
  />
);

function Examples() {
  return (
    <div className="flex flex-col gap-6">
      <Tombstone shape="post" />
      <Tombstone shape="post" reason="deleted" />
      <Tombstone shape="post" reason="withheld" />
      <CoverGrid ratio="3:4">
        {liveCard}
        <Tombstone shape="card" />
        <Tombstone shape="card" reason="deleted" />
        <Tombstone shape="card" reason="withheld" />
        {liveCard}
      </CoverGrid>
      <CoverRow ratio="1:1" label="Record references">
        {liveCard}
        <Tombstone shape="card" reason="deleted" />
        <Tombstone shape="card" reason="withheld" />
      </CoverRow>
      <ul className="flex flex-col gap-2">
        <li>
          <Tombstone shape="row" />
        </li>
        <li>
          <Tombstone shape="row" reason="deleted" />
        </li>
        <li>
          <Tombstone shape="row" reason="withheld" />
        </li>
      </ul>
      <Tombstone
        shape="post"
        reason="deleted"
        restoreUntil={new Date(Date.now() + 30 * 86_400_000)}
        onRestore={() => {}}
      />
    </div>
  );
}

export const Light: Story = { globals: { theme: 'light' }, render: () => <Examples /> };
export const Dark: Story = { ...Light, globals: { theme: 'dark' } };

export const Footprints: Story = {
  render: () => <Examples />,
  async play({ canvasElement }) {
    for (const width of [390, 1280]) {
      canvasElement.style.width = `${width}px`;
      for (const collection of canvasElement.querySelectorAll('.\\@container > .grid, [role=region]')) {
        const frames = collection.querySelectorAll('[data-slot=aspect-ratio]');
        const first = frames[0]!.getBoundingClientRect();
        for (const frame of frames) {
          const rect = frame.getBoundingClientRect();
          await expect(Math.abs(rect.width - first.width)).toBeLessThan(1);
          await expect(Math.abs(rect.height - first.height)).toBeLessThan(1);
        }
      }
      for (const tombstone of canvasElement.querySelectorAll('[data-slot=tombstone]')) {
        await expect(tombstone.querySelector('a, img, picture, h1, h2, h3')).toBeNull();
        await expect(tombstone.scrollWidth).toBeLessThanOrEqual(tombstone.clientWidth + 1);
      }
    }
    canvasElement.style.removeProperty('width');
  },
};

function DeadlineExample() {
  const [deadline, setDeadline] = useState(new Date(Date.now() + 30 * 86_400_000));
  const [restored, setRestored] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      {(['post', 'card', 'row'] as const).map((shape) => (
        <Tombstone
          key={shape}
          shape={shape}
          reason="deleted"
          restoreUntil={deadline}
          onRestore={() => setRestored((count) => count + 1)}
          className="w-40"
        />
      ))}
      <p>Restored {restored} times</p>
      <button onClick={() => setDeadline(new Date(Date.now() + 250))}>End restore window</button>
      <Tombstone shape="row" reason="withheld" restoreUntil={deadline} onRestore={() => {}} />
      <Tombstone shape="row" reason="deleted" labels={{ deleted: 'Removed item' }} />
    </div>
  );
}

export const Deadline: Story = {
  render: () => <DeadlineExample />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('Restore window ends in 30 days')).toHaveLength(3);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Restore' })[0]!);
    await expect(canvas.getByText('Restored 1 times')).toBeVisible();
    const owners = [...canvasElement.querySelectorAll('[data-slot=tombstone]')].slice(0, 3);
    const before = owners.map((element) => element.getBoundingClientRect().height);
    await userEvent.click(canvas.getByRole('button', { name: 'End restore window' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument());
    await expect(canvasElement.querySelector('time')).toBeNull();
    await expect(owners.map((element) => element.getBoundingClientRect().height)).toEqual(before);
    await expect(canvas.getByText('Removed item')).toBeVisible();
  },
};
