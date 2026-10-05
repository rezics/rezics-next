import { type MediaImageMetadata, ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneShowcaseArt, ZoneShowcaseLogo } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { WorkShowcase } from '../api/showcase.ts';
import { workShowcaseArt } from '../realm/adapt.ts';
import type { ShowcaseMessages } from './messages.ts';
import { Background } from './slide.tsx';
import { logoFor, stageWindows } from './stage.ts';
import { Trailer } from './trailer.tsx';
import './showcase.css';
import './work-header.css';

/** What a Work page needs to open with its showcase art. */
export interface WorkShowcaseHeader {
  art: ZoneShowcaseArt;
  trailer: { href: string } | null;
  messages: ShowcaseMessages;
  /** Its images' metadata, read with the page so the art is drawn (or masked) in the server's HTML. */
  images?: Readonly<Record<string, MediaImageMetadata>>;
}

const unresolved = {};

/**
 * The header's art from one batch read, or null when the Work has no
 * background to open with: a logo or a trailer alone leaves the plain header.
 */
export function workShowcaseHeader(
  item: WorkShowcase | undefined,
  messages: ShowcaseMessages,
  images: WorkShowcaseHeader['images'] = unresolved,
): WorkShowcaseHeader | null {
  if (!item) return null;
  const art = workShowcaseArt(item);
  if (!art.landscape && !art.portrait) return null;
  return { art, trailer: item.trailer ? { href: item.trailer.url } : null, messages, images };
}

/** The logo in the title's language, or a language-neutral one; a logo in another language never replaces the title. */
export const workHeaderLogo = (header: WorkShowcaseHeader, language: string): ZoneShowcaseLogo | null =>
  logoFor(header.art, language);

/** The same window shapes as the Zone stage, so the art matches its frame without a second table. */
const heights = { portrait: 'min(calc((100vw - 2rem) * 1.17333), 70svh)', landscape: 'min(42vw, 60svh, 30rem)' };
/** On a phone the text fills the card, so space above it keeps the art's focal area in view. */
const leads = { portrait: 'min(40vw, 16svh)', landscape: '0rem' };
const heroCss = stageWindows
  .map(
    (window) => `@media ${window.media} {
  .work-hero { --hero-height: ${heights[window.shape]}; --hero-lead: ${leads[window.shape]}; }
  .work-hero .showcase-background { --crop-ratio: var(--crop-ratio-${window.shape}); --crop-width: var(--crop-width-${window.shape}); --crop-height: var(--crop-height-${window.shape}); --crop-x: var(--crop-x-${window.shape}); --crop-y: var(--crop-y-${window.shape}); --image-width: var(--image-width-${window.shape}); --image-height: var(--image-height-${window.shape}); --image-left: var(--image-left-${window.shape}); --image-top: var(--image-top-${window.shape}); }
}`,
  )
  .join('\n');

/** Places the Work's live header over its background; the art is decorative and never carries text. */
export function WorkArtHero({ header, children }: { header: WorkShowcaseHeader; children: ReactNode }) {
  return (
    <div className="work-hero">
      <style>{heroCss}</style>
      <ResolvedMediaImages images={header.images ?? unresolved}>
        <Background art={header.art} first />
        <span aria-hidden="true" className="showcase-scrim" />
        <div className="work-hero-copy">{children}</div>
      </ResolvedMediaImages>
    </div>
  );
}

export function WorkTrailer({ header, title }: { header: WorkShowcaseHeader; title: string }) {
  return header.trailer ? (
    <Trailer href={header.trailer.href} label={header.messages.watchTrailer} title={title} />
  ) : null;
}
