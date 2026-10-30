import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = { title: 'Patterns/Library/Continue', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const sample = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  title: 'Kokoro',
  types: ['schema:Book'],
};
const cover = { subject: sample, cover: null, src: coverSrc };

function Continue({ kind }: { kind: 'fraction' | 'position' | 'none' }) {
  const progress =
    kind === 'fraction'
      ? { value: 0.35, label: 'Chapter 14 · 7/20' }
      : kind === 'position'
        ? { value: null, label: 'Chapter 14' }
        : undefined;
  return (
    <CoverGrid ratio="5:7">
      <CoverCard
        href={`/en/library/progress?subjectId=${sample.id}`}
        title={sample.title}
        linkLabel={m.library_continue()}
        cover={cover}
        {...(progress ? { progress } : {})}
      />
    </CoverGrid>
  );
}

async function followsProgressLink(canvasElement: HTMLElement) {
  const link = within(canvasElement).getByRole('link', { name: m.library_continue() });
  await expect(link).toHaveAttribute('href', `/en/library/progress?subjectId=${sample.id}`);
}

export const FractionProgress: Story = {
  render: () => (
    <PatternStory>
      <Continue kind="fraction" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    await followsProgressLink(canvasElement);
    await expect(within(canvasElement).getByText('Chapter 14 · 7/20')).toBeVisible();
  },
};

export const PositionOnlyProgress: Story = {
  render: () => (
    <PatternStory>
      <Continue kind="position" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    await followsProgressLink(canvasElement);
    await expect(within(canvasElement).getByText('Chapter 14')).toBeVisible();
    await expect(within(canvasElement).queryByRole('progressbar')).toBeNull();
  },
};

export const NoProgress: Story = {
  render: () => (
    <PatternStory>
      <Continue kind="none" />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    await followsProgressLink(canvasElement);
    await expect(within(canvasElement).queryByRole('progressbar')).toBeNull();
    await expect(within(canvasElement).queryByText('Chapter 14')).toBeNull();
  },
};
