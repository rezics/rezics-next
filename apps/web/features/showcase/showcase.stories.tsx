import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { presetTokens } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import { Showcase } from './showcase.tsx';
import {
  fixtureArt,
  showcaseCopy,
  showcaseFixtures,
  type ShowcaseLanguage,
  showcaseLocale,
  showcaseViewports,
} from './fixtures.ts';

function Preview({
  language,
  variant,
  effect,
}: {
  language: ShowcaseLanguage;
  variant:
    | 'art'
    | 'cover'
    | 'landscape'
    | 'foreign-logo'
    | 'trailer'
    | 'poster'
    | 'failed-logo'
    | 'wide-focal'
    | 'pending-crop';
  effect: 'plain' | 'outline' | 'gradient' | 'glow';
}) {
  const theme = zoneTheme(presetTokens.vibrant, { reader: 'dark', enabled: true });
  const slides = showcaseFixtures(language);
  if (variant === 'cover') slides[0] = { ...slides[1]!, id: 'lead-cover' };
  if (variant === 'landscape')
    slides[0] = { ...slides[0]!, art: { ...fixtureArt, portrait: null } };
  if (variant === 'wide-focal')
    slides[0] = {
      ...slides[0]!,
      art: {
        ...fixtureArt,
        portrait: null,
        landscape: { ...fixtureArt.landscape!, focal: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 } },
      },
    };
  // The author framed the middle half of the original, and its renditions are not made yet.
  if (variant === 'pending-crop')
    slides[0] = {
      ...slides[0]!,
      art: {
        landscape: {
          ...fixtureArt.landscape!,
          focal: undefined,
          candidates: [],
          view: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        },
      },
    };
  if (variant === 'foreign-logo')
    slides[0] = {
      ...slides[0]!,
      art: { ...fixtureArt, logos: fixtureArt.logos?.filter((logo) => logo.language === 'ja') },
    };
  if (variant === 'trailer')
    slides[0] = { ...slides[0]!, trailer: { href: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' } };
  if (variant === 'poster')
    slides[0] = { ...slides[0]!, art: { landscape: { ...fixtureArt.portrait!, framed: false } } };
  if (variant === 'failed-logo')
    slides[0] = {
      ...slides[0]!,
      art: {
        ...fixtureArt,
        logos: fixtureArt.logos?.map((logo) => ({
          ...logo,
          candidates: undefined,
          url: '/missing-showcase-logo.svg',
        })),
      },
    };
  return (
    <main
      className={`${theme.className} min-h-dvh bg-(--zone-page) py-6`}
      style={theme.style}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
    >
      <Showcase
        slides={slides}
        label="Featured"
        locale={showcaseLocale(language)}
        messages={showcaseCopy(language)}
        effect={effect}
        direction={language === 'ar' ? 'rtl' : 'ltr'}
      />
    </main>
  );
}
const meta = {
  title: 'Showcase/Stage',
  component: Preview,
  args: { language: 'en', variant: 'art', effect: 'outline' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
  async play({ canvasElement }) {
    const stage = canvasElement.querySelector('.showcase-stage')!.getBoundingClientRect();
    const controls = canvasElement.querySelector('.showcase-controls')!.getBoundingClientRect();
    await expect(controls.top).toBeGreaterThanOrEqual(stage.bottom - 1);
    for (const stamp of canvasElement.querySelectorAll('.showcase-why')) {
      const box = stamp.getBoundingClientRect();
      await expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    }
    const region = within(canvasElement).getByRole('region', { name: 'Featured' });
    const links = canvasElement.querySelectorAll('.showcase-tagline');
    await expect([...links].every((element) => element.closest('.showcase-slide'))).toBe(true);
    if (matchMedia('(pointer: coarse)').matches || (innerWidth < 768 && innerHeight > innerWidth))
      await expect(within(region).queryByRole('button', { name: 'Next' })).toBeNull();
  },
  async afterEach({ id }) {
    if (import.meta.env.VITE_SHOWCASE_VISUAL !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    const suffix = import.meta.env.VITE_SHOWCASE_REDUCED === '1' ? '-reduce' : '';
    await page.screenshot({ path: `../../../../.temp/showcase/${id}${suffix}.png` });
  },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

async function inspectAndCapture(language: ShowcaseLanguage) {
  if (import.meta.env.VITE_SHOWCASE_VISUAL !== '1') return;
  const { page } = await import('vitest/browser');
  for (const [name, [width, height]] of Object.entries(showcaseViewports)) {
    await page.viewport(width, height);
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    await page.screenshot({ path: `../../../../.temp/showcase/${language}-${name}.png` });
  }
}
export const English: Story = {
  async play({ canvasElement }) {
    const image = canvasElement.querySelector<HTMLImageElement>('img.showcase-art');
    await waitFor(() => expect(image?.naturalWidth).toBeGreaterThan(0));
    await inspectAndCapture('en');
  },
};
export const TraditionalChinese: Story = {
  args: { language: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play() {
    await inspectAndCapture('zh-Hant');
  },
};
export const Japanese: Story = {
  args: { language: 'ja' },
  globals: { locale: 'ja' },
  async play() {
    await inspectAndCapture('ja');
  },
};
export const ArabicContent: Story = {
  args: { language: 'ar', effect: 'glow' },
  async play() {
    await inspectAndCapture('ar');
  },
};
export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await waitFor(() =>
      expect(
        canvasElement.querySelector('[data-slot="carousel-item"][data-index="1"]'),
      ).toHaveAttribute('inert'),
    );
  },
};
export const FoldCover: Story = { globals: { viewport: { value: 'foldCover' } } };
export const TabletPortrait: Story = { globals: { viewport: { value: 'tabletPortrait' } } };
export const TabletLandscape: Story = { globals: { viewport: { value: 'tabletLandscape' } } };
export const FoldInner: Story = { globals: { viewport: { value: 'foldInner' } } };
export const PhoneLandscape: Story = { globals: { viewport: { value: 'phoneLandscape' } } };
export const Desktop: Story = { globals: { viewport: { value: 'desktop' } } };
export const WideDesktop: Story = { globals: { viewport: { value: 'desktopWide' } } };
export const NoArt: Story = {
  args: { variant: 'cover', effect: 'gradient' },
  globals: { viewport: { value: 'phone' } },
};
export const NoPortrait: Story = {
  args: { variant: 'landscape' },
  globals: { viewport: { value: 'phone' } },
};
export const NoPortraitWideFocal: Story = {
  args: { variant: 'wide-focal' },
  globals: { viewport: { value: 'phone' } },
};
export const ForeignLanguageLogo: Story = {
  args: { variant: 'foreign-logo' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Astral Tide' })).toBeVisible();
  },
};
/** Until renditions exist the stage draws the authored crop from the original, so the frame shows what the author chose. */
export const PendingRenditionCrop: Story = {
  args: { variant: 'pending-crop' },
  async play({ canvasElement }) {
    const image = canvasElement.querySelector<HTMLImageElement>('.showcase-image-frame:not(.showcase-ambient) img.showcase-art');
    await waitFor(() => expect(image?.naturalWidth).toBeGreaterThan(0));
    const original = image!.getBoundingClientRect();
    const frame = image!.closest('picture')!.getBoundingClientRect();
    await expect(original.width).toBeCloseTo(frame.width * 2, 0);
    await expect(original.height).toBeCloseTo(frame.height * 2, 0);
    await expect(original.left + original.width / 4).toBeCloseTo(frame.left, 0);
    await expect(original.top + original.height / 4).toBeCloseTo(frame.top, 0);
  },
};
export const WholePoster: Story = { args: { variant: 'poster' } };
export const UnavailableLogo: Story = {
  args: { variant: 'failed-logo' },
  async play({ canvasElement }) {
    await waitFor(() =>
      expect(within(canvasElement).getByRole('heading', { name: 'Astral Tide' })).toBeVisible(),
    );
  },
};
export const ReducedMotion: Story = {
  async play({ canvasElement }) {
    if (import.meta.env.VITE_SHOWCASE_REDUCED !== '1') return;
    await expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    await expect(
      within(canvasElement).queryByRole('button', { name: 'Pause rotation' }),
    ).toBeNull();
    const cutout = canvasElement.querySelector('.showcase-cutout');
    await expect(cutout && getComputedStyle(cutout).transform).toBe('none');
  },
};
export const TrailerFacade: Story = {
  args: { variant: 'trailer' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(document.querySelector('iframe[src*="youtube-nocookie"]')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Watch trailer' }));
    await waitFor(() => expect(within(document.body).getByRole('dialog')).toBeVisible());
    await expect(document.querySelector('iframe[src*="youtube-nocookie"]')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(document.querySelector('iframe[src*="youtube-nocookie"]')).toBeNull(),
    );
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull());
  },
};
export const ManualNavigation: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('group', { name: 'Astral Tide · 1 of 3' });
    await expect(first).not.toHaveAttribute('inert');
    if (import.meta.env.MODE === 'test') {
      const { page } = await import('vitest/browser');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    } else await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await waitFor(
      () =>
        expect(
          canvas.getByRole('group', { name: 'The Cartographer’s Library · 2 of 3' }),
        ).toBeVisible(),
      { timeout: 4000 },
    );
    await waitFor(() => expect(first).toHaveAttribute('inert'));
    await waitFor(async () => {
      const selected = canvas.getByRole('group', { name: 'The Cartographer’s Library · 2 of 3' });
      const stage = canvasElement.querySelector('.showcase-stage')!.getBoundingClientRect();
      await expect(Math.abs(selected.getBoundingClientRect().left - stage.left)).toBeLessThan(1);
    });
  },
};
