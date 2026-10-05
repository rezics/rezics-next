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
  variant: 'art' | 'cover' | 'landscape' | 'foreign-logo' | 'trailer' | 'poster' | 'failed-logo';
  effect: 'plain' | 'outline' | 'gradient' | 'glow';
}) {
  const theme = zoneTheme(presetTokens.vibrant, { reader: 'dark', enabled: true });
  const slides = showcaseFixtures(language);
  if (variant === 'cover') slides[0] = { ...slides[1]!, id: 'lead-cover' };
  if (variant === 'landscape')
    slides[0] = { ...slides[0]!, art: { ...fixtureArt, portrait: null } };
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
      <p className="mx-auto mt-6 max-w-3xl px-6 text-sm text-muted-foreground">
        {slides[1]?.tagline?.value}
      </p>
    </main>
  );
}
const meta = {
  title: 'Showcase/Stage',
  component: Preview,
  args: { language: 'en', variant: 'art', effect: 'outline' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
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
export const ForeignLanguageLogo: Story = {
  args: { variant: 'foreign-logo' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Astral Tide' })).toBeVisible();
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
  },
};
export const ManualNavigation: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('group', { name: 'Astral Tide · 1 of 3' });
    await expect(first).not.toHaveAttribute('inert');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await waitFor(
      () =>
        expect(
          canvas.getByRole('group', { name: 'The Cartographer’s Library · 2 of 3' }),
        ).toBeVisible(),
      { timeout: 4000 },
    );
    await waitFor(() => expect(first).toHaveAttribute('inert'));
  },
};
