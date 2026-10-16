import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MediaImageProvider, ResolvedMediaImages, type MediaImageMetadata } from '@rezics/ui/media-image';
import { mediaImageKey } from '@rezics/ui/media-image-key';
import { imageReferenceFromUrl } from '../api/media-metadata.ts';
import { knownCoverCredit, mixedScriptCoverCredit } from '../rights-mark/fixtures.ts';
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
    | 'imported-cover'
    | 'imported-cover-as-art'
    | 'imported-cover-long'
    | 'landscape'
    | 'foreign-logo'
    | 'trailer'
    | 'poster'
    | 'failed-logo'
    | 'wide-focal'
    | 'pending-crop'
    | 'described';
  effect: 'plain' | 'outline' | 'gradient' | 'glow';
}) {
  const theme = zoneTheme(presetTokens.vibrant, { reader: 'dark', enabled: true });
  const slides = showcaseFixtures(language);
  const importedCoverUrl = '/api/main/v1/media/avatars/01a0e3d1-0000-7000-8000-000000000002';
  const imported = variant === 'imported-cover' || variant === 'imported-cover-as-art' || variant === 'imported-cover-long';
  if (imported) {
    const own = slides[1]!;
    slides[0] = { ...own, id: 'lead-imported-cover', work: { ...own.work!,
      cover: { url: importedCoverUrl, width: 750, height: 1000 } },
      art: variant === 'imported-cover-as-art'
        ? { landscape: { ...fixtureArt.landscape!, url: importedCoverUrl },
          cutout: { ...fixtureArt.cutout!, url: importedCoverUrl },
          logos: [{ ...fixtureArt.logos![0]!, url: importedCoverUrl }] } : null };
  }
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
  if (variant === 'described')
    slides[0] = {
      ...slides[0]!,
      art: { ...fixtureArt, landscape: { ...fixtureArt.landscape!, alt: 'A tide rising under a field of stars' } },
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
  const preview = (
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
  if (!imported) return preview;
  const reference = imageReferenceFromUrl(importedCoverUrl)!;
  const key = mediaImageKey(reference);
  const images: Record<string, MediaImageMetadata> = { [key]: { ...reference,
    requestKey: key, src: fixtureArt.portrait!.url, nsfw: 'sfw',
    ageRating: { status: 'unassessed' }, conceal: false,
    coverCredit: variant === 'imported-cover-long' ? mixedScriptCoverCredit : knownCoverCredit } };
  return <MediaImageProvider viewer={{ ready: true, signedIn: false, age: 'unknown', nsfwDisplay: 'mask',
    optIns: { general: true, r15: false, sexual: false, grotesque: false } }}
    referenceFromUrl={imageReferenceFromUrl} resolve={async () => []}>
    <ResolvedMediaImages images={images}>{preview}</ResolvedMediaImages>
  </MediaImageProvider>;
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
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  async play({ canvasElement }) {
    const image = canvasElement.querySelector<HTMLImageElement>('img.showcase-art');
    await waitFor(() => expect(image?.naturalWidth).toBeGreaterThan(0));
  },
};
export const TraditionalChinese: Story = {
  args: { language: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play() {
    // The QA runner captures this localized preview after play.
  },
};
export const Japanese: Story = {
  args: { language: 'ja' },
  globals: { locale: 'ja' },
  async play() {
    // The QA runner captures this localized preview after play.
  },
};
export const ArabicContent: Story = {
  args: { language: 'ar', effect: 'glow' },
  async play() {
    // The QA runner captures this localized preview after play.
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
export const ImportedCover: Story = {
  args: { variant: 'imported-cover', effect: 'plain' },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const lead = canvasElement.querySelector('.showcase-slide')!;
    const image = lead.querySelector<HTMLImageElement>('.showcase-cover img');
    await waitFor(() => expect(image?.naturalWidth).toBeGreaterThan(0));
    await expect(lead.querySelector('.showcase-cover-ambient, .showcase-generated-ambient, .showcase-background, source')).toBeNull();
    await expect(lead.querySelector('.showcase-logo')).toBeNull();
    await expect(canvasElement.querySelector('.showcase-cutout')).toBeNull();
    const source = within(lead as HTMLElement).getByRole('link', { name: knownCoverCredit.source.name });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', knownCoverCredit.source.href);
    await expect(source.closest('[aria-hidden="true"]')).toBeNull();
    await expect(source.parentElement?.closest('a')).toBeNull();
    source.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(source).toHaveFocus();
  },
};
export const ImportedCoverRejectedAsArt: Story = {
  ...ImportedCover,
  args: { variant: 'imported-cover-as-art', effect: 'plain' },
};
export const ImportedCoverLongMixedScripts: Story = {
  args: { variant: 'imported-cover-long', effect: 'plain' },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const lead = canvasElement.querySelector<HTMLElement>('.showcase-slide')!;
    const image = lead.querySelector<HTMLImageElement>('.showcase-cover img');
    await waitFor(() => expect(image?.naturalWidth).toBeGreaterThan(0));
    const credit = lead.querySelector<HTMLElement>('[data-cover-credit]')!;
    await expect(credit).toHaveTextContent(mixedScriptCoverCredit.text);
    const source = within(lead).getByRole('link', { name: mixedScriptCoverCredit.source.name });
    await expect(source).toHaveAttribute('href', mixedScriptCoverCredit.source.href);
    await expect(source.closest('.showcase-copy')).not.toBeNull();
    await expect(lead.scrollWidth).toBeLessThanOrEqual(lead.clientWidth + 1);
    await expect(getComputedStyle(lead).overflowY).toBe('auto');
    source.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(source).toHaveFocus();
    // The complete mark remains reachable inside the fixed-height stage.
    credit.scrollIntoView({ block: 'nearest' });
    const frame = lead.getBoundingClientRect();
    const notice = credit.getBoundingClientRect();
    await expect(notice.top).toBeGreaterThanOrEqual(frame.top - 1);
    await expect(notice.bottom).toBeLessThanOrEqual(frame.bottom + 1);
    await expect(notice.left).toBeGreaterThanOrEqual(frame.left - 1);
    await expect(notice.right).toBeLessThanOrEqual(frame.right + 1);
  },
};
export const NoPortrait: Story = {
  args: { variant: 'landscape' },
  globals: { viewport: { value: 'phone' } },
};
export const NoPortraitWideFocal: Story = {
  args: { variant: 'wide-focal' },
  globals: { viewport: { value: 'phone' } },
};
/** A screen reader hears the slide's heading once and its authored image description once, not the logo or the blurred copy. */
export const AuthoredAlt: Story = {
  args: { variant: 'described' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('img', { name: 'A tide rising under a field of stars' })).toHaveLength(1);
    await expect(canvas.getAllByRole('heading', { name: 'Astral Tide' })).toHaveLength(1);
    await expect(canvas.queryByRole('img', { name: 'Astral Tide' })).toBeNull();
  },
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
    const first = canvas.getByRole('group', { name: '1 of 3' });
    await expect(first).not.toHaveAttribute('inert');
    if (import.meta.env.MODE === 'test') {
      const { page } = await import('vitest/browser');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    } else await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await waitFor(
      () =>
        expect(
          canvas.getByRole('group', { name: '2 of 3' }),
        ).toBeVisible(),
      { timeout: 4000 },
    );
    await waitFor(() => expect(first).toHaveAttribute('inert'));
    await waitFor(async () => {
      const selected = canvas.getByRole('group', { name: '2 of 3' });
      const stage = canvasElement.querySelector('.showcase-stage')!.getBoundingClientRect();
      await expect(Math.abs(selected.getBoundingClientRect().left - stage.left)).toBeLessThan(1);
    });
  },
};
