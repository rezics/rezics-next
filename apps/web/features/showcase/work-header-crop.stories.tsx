import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneShowcaseArt } from '@rezics/zone-sdk';
import { expect, waitFor } from 'storybook/test';
import { showcaseCopy, showcaseFixtures, showcaseLocale } from './fixtures.ts';
import { Showcase } from './showcase.tsx';
import { stageWindows } from './stage.ts';
import { WorkArtHero } from './work-header.tsx';
import { messages } from './messages.ts';
import url from './work-header-crop.svg?url&no-inline';

// The red half must never enter either authored crop. Lines inside the blue
// half make distortion and misplaced crop boundaries visible in screenshots.
const art: ZoneShowcaseArt = {
  landscape: {
    url,
    width: 480,
    height: 270,
    framed: true,
    candidates: [],
    view: { x: 0.5, y: 0.25, width: 0.4, height: 0.3375 },
  },
  portrait: {
    url,
    width: 360,
    height: 480,
    framed: true,
    candidates: [],
    view: { x: 0.6, y: 0.125, width: 0.3, height: 0.6 },
  },
};

function Preview({ surface }: { surface: 'stage' | 'work' }) {
  const slide = { ...showcaseFixtures('en')[0]!, art };
  return (
    <div style={{ padding: '1rem' }}>
      {surface === 'stage' ? (
        <Showcase
          slides={[slide]}
          label="Featured Works"
          locale={showcaseLocale('en')}
          messages={showcaseCopy('en')}
        />
      ) : (
        <WorkArtHero header={{ art, trailer: null, messages: messages.en }}>
          <h1>Astral Tide</h1>
          <p>A Work header with a pending crop ladder.</p>
        </WorkArtHero>
      )}
    </div>
  );
}

async function cropFits(canvasElement: HTMLElement) {
  await waitFor(async () => {
    const picture = canvasElement.querySelector<HTMLElement>(
      '.showcase-image-frame:not(.showcase-ambient) .showcase-crop',
    )!;
    const image = picture?.querySelector<HTMLImageElement>('img');
    await expect(image?.complete && image.naturalWidth).toBeTruthy();
    const portrait = window.matchMedia(stageWindows[0].media).matches;
    const view = (portrait ? art.portrait : art.landscape)!.view!;
    const crop = picture.getBoundingClientRect();
    const original = image!.getBoundingClientRect();
    await expect(crop.width).toBeGreaterThan(100);
    await expect(crop.height).toBeGreaterThan(100);
    await expect(original.width * view.width).toBeCloseTo(crop.width, 0);
    await expect(original.height * view.height).toBeCloseTo(crop.height, 0);
    await expect(original.left + original.width * view.x).toBeCloseTo(crop.left, 0);
    await expect(original.top + original.height * view.y).toBeCloseTo(crop.top, 0);
    // Preserving the original's aspect ratio also preserves circles in the crop.
    await expect(original.width / original.height).toBeCloseTo(1.5, 2);
  });
}

const meta = {
  title: 'Showcase/Pending crop',
  component: Preview,
  args: { surface: 'stage' },
  play: ({ canvasElement }) => cropFits(canvasElement),
  async afterEach({ id }) {
    if (import.meta.env.VITE_SHOWCASE_VISUAL !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/showcase-crop/${id}.png` });
  },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StagePhone: Story = { globals: { viewport: { value: 'phone' } } };
export const StageDesktop: Story = { globals: { viewport: { value: 'desktop' } } };
export const WorkPhone: Story = {
  args: { surface: 'work' },
  globals: { viewport: { value: 'phone' } },
};
export const WorkDesktop: Story = {
  args: { surface: 'work' },
  globals: { viewport: { value: 'desktop' } },
};
