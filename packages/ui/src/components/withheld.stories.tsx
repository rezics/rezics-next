import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CoverCard, CoverGrid } from './cover-card.tsx';
import { Withheld } from './withheld.tsx';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'Components/Content/Withheld',
  component: Withheld,
  args: { shape: 'passage' },
  decorators: [withSurface],
} satisfies Meta<typeof Withheld>;
export default meta;
type Story = StoryObj<typeof meta>;

function Examples() {
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Covers">
        <CoverGrid ratio="3:4">
          <CoverCard
            href="/garden"
            title="The garden notebook"
            secondary="M. Green"
            state="Reading"
            cover={{
              subject: { id: 'garden', title: 'The garden notebook', types: ['schema:Book'] },
              cover: null,
              src: () => '',
            }}
          />
          <article className="min-w-0 overflow-hidden rounded-lg bg-card shadow-sm">
            <Withheld shape="image" ratio={3 / 4} />
            <div className="flex min-h-24 flex-col gap-1 p-3 text-center text-sm">
              <h2 className="work-title">A coastal journal</h2>
              <p className="text-muted-foreground">N. Shore</p>
              <p>Planned</p>
            </div>
          </article>
        </CoverGrid>
      </section>
      <article aria-label="A record with one withheld passage" className="flex max-w-prose flex-col gap-4">
        <h2 className="text-lg font-semibold">Notes from the coast</h2>
        <p>The public introduction is still here.</p>
        <Withheld shape="passage" style={{ minHeight: 160 }} />
        <p>The rest of the record remains readable.</p>
        <Withheld shape="field" label="Translator" />
        <dl className="flex gap-3 text-sm">
          <dt>Published</dt>
          <dd>2026</dd>
        </dl>
      </article>
    </div>
  );
}

const footprints: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  try {
    for (const width of [390, 1280]) {
      canvasElement.style.width = `${width}px`;
      const frames = canvasElement.querySelectorAll('[data-slot="cover"], [data-slot="withheld"][data-shape="image"]');
      await expect(frames).toHaveLength(2);
      const first = frames[0]!.getBoundingClientRect();
      for (const frame of frames) {
        const rect = frame.getBoundingClientRect();
        await expect(Math.abs(rect.width - first.width)).toBeLessThan(1);
        await expect(Math.abs(rect.height - first.height)).toBeLessThan(1);
        await expect(Math.abs(rect.width / rect.height - 3 / 4)).toBeLessThan(0.01);
      }
      const passage = canvasElement.querySelector('[data-shape="passage"]')!;
      await expect(passage.getBoundingClientRect().height).toBe(160);
      for (const part of canvasElement.querySelectorAll('[data-slot="withheld"]')) {
        await expect(part.querySelector('a, button, img, picture, input')).toBeNull();
        await expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth + 1);
      }
      await expect(canvas.getByText('The public introduction is still here.')).toBeVisible();
      await expect(canvas.getByText('The rest of the record remains readable.')).toBeVisible();
      await expect(canvas.getByText('Translator')).toBeVisible();
      await expect(canvas.getByText('2026')).toBeVisible();
    }
  } finally {
    canvasElement.style.width = '';
  }
};

export const Light: Story = { globals: { theme: 'light' }, render: () => <Examples />, play: footprints };
export const Dark: Story = { ...Light, globals: { theme: 'dark' } };
