import type {
  ZoneShowcaseArt,
  ZoneShowcaseImage,
  ZoneShowcaseLogo,
  ZoneShowcaseSlide,
} from '@rezics/zone-sdk';

/** These disjoint window shapes drive CSS, picture selection and preload selection together. */
export const stageWindows = [
  {
    shape: 'portrait',
    media: '(width < 768px) and (orientation: portrait)',
    ratio: '3 / 4',
    width: 'min(calc((100vw - 2rem) * .88), 52.5svh)',
    height: 'min(calc((100vw - 2rem) * 1.17333), 70svh)',
    sizes: '(max-width: 767px) 88vw, 100vw',
  },
  {
    shape: 'landscape',
    media: '(width >= 768px), (orientation: landscape)',
    ratio: '16 / 9',
    width: 'min(100%, 115.555svh, 71.111rem)',
    height: 'min(56.25vw, 65svh, 40rem)',
    sizes: '(min-width: 1200px) 70vw, 100vw',
  },
] as const;
export const rotationWindow =
  '(min-width: 1200px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
export const rotationDelay = 7000;

export const stageWindowCss = stageWindows
  .map(
    (window) => `@media ${window.media} {
  .showcase { --showcase-ratio: ${window.ratio}; --showcase-width: ${window.width}; --showcase-height: ${window.height}; }
  ${
    window.shape === 'portrait'
      ? `
  .showcase-stage { width: 100%; }
  .showcase .showcase-controls { width: var(--showcase-width); margin-inline: 0; }
  .showcase .showcase-arrows, .showcase .showcase-rotation { display: none; }
  .showcase .showcase-item { width: var(--showcase-width); }
  .showcase-background { --crop-ratio: var(--crop-ratio-portrait); --crop-width: var(--crop-width-portrait); --crop-height: var(--crop-height-portrait); --crop-x: var(--crop-x-portrait); --crop-y: var(--crop-y-portrait); --image-width: var(--image-width-portrait); --image-height: var(--image-height-portrait); --image-left: var(--image-left-portrait); --image-top: var(--image-top-portrait); }
  .showcase-copy { width: 100%; padding: 1.25rem; gap: .5rem; }
  .showcase-title { font-size: clamp(1.5rem, min(7cqw, 4.2svh), 2.5rem); }
  .showcase-cutout-layer { inset-block: -3% 45%; inset-inline: 45% 10%; }
  .showcase-cover-slide { flex-direction: column; justify-content: end; }
  .showcase-cover { width: 31%; max-height: 45%; margin: 1rem auto 0; }
  .showcase-cover-slide .showcase-copy { width: 100%; }
  .showcase-logo { max-width: 58%; max-height: 20%; }
  .showcase-logo-bottom-start, .showcase-logo-bottom-end { bottom: 43%; }
  `
      : ''
  }
}`,
  )
  .join('\n');

export function slideArt(slide: ZoneShowcaseSlide): ZoneShowcaseArt | null {
  const campaign = slide.art;
  const own = slide.work?.showcaseArt;
  const selected =
    campaign?.landscape || campaign?.portrait
      ? campaign
      : own?.landscape || own?.portrait
        ? own
        : (campaign ?? own);
  return selected ?? null;
}
export const imageSet = (image: ZoneShowcaseImage) =>
  image.candidates?.length
    ? image.candidates.map((candidate) => `${candidate.url} ${candidate.width}w`).join(', ')
    : `${image.url} ${image.width}w`;

export function pictureSources(art: ZoneShowcaseArt) {
  return stageWindows.flatMap((window) => {
    const image =
      window.shape === 'portrait'
        ? (art.portrait ?? art.landscape)
        : (art.landscape ?? art.portrait);
    return image
      ? [
          ...(image.avifCandidates?.length
            ? [
                {
                  ...window,
                  image,
                  type: 'image/avif',
                  srcSet: image.avifCandidates
                    .map((candidate) => `${candidate.url} ${candidate.width}w`)
                    .join(', '),
                },
              ]
            : []),
          { ...window, image, type: undefined, srcSet: imageSet(image) },
        ]
      : [];
  });
}

export function logoFor(
  art: ZoneShowcaseArt | null,
  locale: string,
  tone: ZoneShowcaseLogo['tone'] = 'light',
) {
  const logos = art?.logos?.filter((logo) => logo.tone === tone) ?? [];
  return (
    logos.find((logo) => logo.language.toLowerCase() === locale.toLowerCase()) ??
    logos.find((logo) => !logo.language) ??
    null
  );
}

export function focalPosition(image: ZoneShowcaseImage) {
  const focal = image.focal;
  return focal
    ? `${Math.max(0, Math.min(1, focal.x + focal.width / 2)) * 100}% ${Math.max(0, Math.min(1, focal.y + focal.height / 2)) * 100}%`
    : '50% 50%';
}

/** Fit the authored crop first, then expand and offset its original within it.
 * The original's pixels remain proportional even when the crop is not centred. */
export function cropGeometry(image: ZoneShowcaseImage, ratio: number, ambient = false) {
  const frame = focalFrame(image, ratio);
  const [x, y] = frame.position.split(' ');
  const view = image.view ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    ratio: image.width / image.height,
    fit: ambient || frame.fit === 'cover' ? 'max' : 'min',
    x,
    y,
    width: `${100 / view.width}%`,
    height: `${100 / view.height}%`,
    left: `${(-100 * view.x) / view.width}%`,
    top: `${(-100 * view.y) / view.height}%`,
  };
}

/** A cover crop is safe only if every point in the authored focal rectangle survives. */
export function focalFrame(image: ZoneShowcaseImage, ratio: number) {
  if (!image.framed) return { fit: 'contain', position: '50% 50%' };
  const originalRatio = image.width / image.height;
  if (Math.abs(originalRatio - ratio) < 0.001)
    return { fit: 'cover', position: focalPosition(image) };
  const focal = image.focal;
  if (!focal) return { fit: 'contain', position: '50% 50%' };
  const width = Math.min(1, ratio / originalRatio),
    height = Math.min(1, originalRatio / ratio);
  if (
    focal.width > width ||
    focal.height > height ||
    focal.x < 0 ||
    focal.y < 0 ||
    focal.x + focal.width > 1 ||
    focal.y + focal.height > 1
  )
    return { fit: 'contain', position: '50% 50%' };
  const position = (origin: number, extent: number, window: number) =>
    window === 1
      ? 50
      : (Math.max(0, Math.min(1 - window, origin + extent / 2 - window / 2)) / (1 - window)) * 100;
  return {
    fit: 'cover',
    position: `${position(focal.x, focal.width, width)}% ${position(focal.y, focal.height, height)}%`,
  };
}

/** Strict provider parsing prevents a supplied URL becoming an arbitrary iframe. No autoplay parameter. */
export function trailerEmbed(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // Keep a linked part, playlist or playback position by opening that exact URL externally.
  if (
    url.hash ||
    ['p', 'cid', 't', 'start', 'time_continue', 'list'].some((key) => url.searchParams.has(key))
  )
    return null;
  if (
    ['youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(
      url.hostname,
    )
  ) {
    const id =
      url.hostname === 'youtu.be'
        ? url.pathname.slice(1)
        : url.pathname.startsWith('/embed/')
          ? url.pathname.slice(7)
          : url.searchParams.get('v');
    return id && /^[\w-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}?rel=0`
      : null;
  }
  if (['bilibili.com', 'www.bilibili.com'].includes(url.hostname)) {
    const id = /^\/video\/(BV[\w]{10})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? `https://player.bilibili.com/player.html?bvid=${id}&autoplay=0` : null;
  }
  return null;
}
