import { direction } from '@rezics/main/language';
import type { ZoneCatalogueFacts, ZoneContext, ZonePackage, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { installHostZoneAddresses } from '../zones/addresses.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { cardRenderer } from '../zones/zone-home.tsx';

const text = (value: string, lang: string): ZoneText => ({ value, lang, dir: direction(lang, value) });
const iri = (name: string) => `https://rezics.com/id/00000000-0000-4000-8000-${name.padStart(12, '0')}`;

export function catalogueZone(slug: 'anime' | 'manga', locale: UiLocale): ZoneContext {
  const home = localizedPath(spaceHref(slug, 'site'), locale);
  return {
    slug,
    realm: iri('1'),
    name: text(slug === 'anime' ? 'Anime' : 'Manga', 'en'),
    description: null,
    icon: null,
    hero: null,
    tokens: presetTokens.editorial,
    locale,
    links: {
      home,
      browse: `${home}/browse`,
      works: `${home}/browse`,
      discussions: localizedPath(spaceHref(slug, 'community', ['discussions']), locale),
      decisions: localizedPath(spaceHref(slug, 'community', ['decisions']), locale),
      about: localizedPath(spaceHref(slug, 'community', ['about']), locale),
    },
  };
}

export function catalogueWork(name: string, title: string, lang: string, status: ZoneWork['status'],
  author: string | null = null): ZoneWork {
  return {
    id: iri(name), href: `/works/${name}`, title: text(title, lang), cover: null, kind: 'book',
    author: author ? text(author, 'en') : null, authorHref: author ? `/@${author}` : null,
    tagline: null, status, chapters: null, words: null, updatedAt: null, decision: null,
  };
}

export function catalogueFacts(format: string | null, years: number[], count: number | null,
  unavailable = false, countName: ZoneText | null = null): ZoneCatalogueFacts {
  return { format: format === null ? null : text(format, 'en'), years, count, countName, unavailable };
}

/** The Zone frame. Children receive the Zone and a card renderer that already has its facts. */
export function CatalogueZoneFrame({ slug, pkg, locale, children }: {
  slug: 'anime' | 'manga';
  pkg: ZonePackage;
  locale: UiLocale;
  children: (zone: ZoneContext, card: (work: ZoneWork, facts: ZoneCatalogueFacts) => ReactNode) => ReactNode;
}) {
  installHostZoneAddresses();
  const zone = catalogueZone(slug, locale);
  const render = cardRenderer(zone, pkg, locale, zoneMessagesFor(locale));
  return <RealmPageStory zone={zone} pkg={pkg} execution={{ mode: 'package', slug }} locale={locale} site>
    {children(zone, (work, facts) => render(work, { facts }))}
  </RealmPageStory>;
}

export const catalogueLink = LocalizedLink;

/** Saves the settled story under the worktree `.temp/` for screen review. The path is relative to the story file. */
export async function captureCatalogueStory(canvas: HTMLElement, name: string) {
  const { page } = await import('vitest/browser');
  await document.fonts.ready;
  const shot = async (element: Element, suffix: string) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    await page.screenshot({
      element,
      path: `../../../../.temp/anime-manga-zones/stories/${name}${suffix}.png`,
    });
  };
  await shot(canvas, '');
  const card = canvas.querySelector('[data-catalogue-card]');
  const panel = canvas.querySelector('[data-catalogue-panel]');
  const footer = canvas.querySelector('footer');
  if (card) await shot(card, '-card');
  if (panel) await shot(panel, '-panel');
  if (footer) await shot(footer, '-footer');
}
