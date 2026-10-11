import { direction } from '@rezics/main/language';
import type { ZoneText, ZoneTokens } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import type { SiteLink } from './site-navigation.tsx';
import { siteHref, zoneNavigationHref } from '../realm/route.ts';

export interface SitePresentationCut {
  tokens: ZoneTokens;
  navigation: readonly { href: string; label: string }[];
}

export interface SiteMountCut {
  segment: string;
  name: ZoneText;
}

/** One rendering input for the public Zone frame and the author's saved preview. */
export function savedSiteCuts(presentation: SitePresentationCut, mounts: readonly SiteMountCut[], ref: string,
  locale: UiLocale, homeName: string): { tokens: ZoneTokens; navigation: SiteLink[] } {
  const navigation: SiteLink[] = [
    { href: siteHref(locale, ref, []), label: { value: homeName, lang: locale, dir: direction(locale, homeName) } },
    ...presentation.navigation.map(item => ({
      href: zoneNavigationHref(item.href, ref),
      label: { value: item.label, lang: locale, dir: direction(locale, item.label) },
    })),
    ...mounts.map(mount => ({ href: spaceHref(ref, 'site', [mount.segment]), label: mount.name })),
  ];
  return {
    tokens: presentation.tokens,
    navigation: navigation.filter((link, index, links) => links.findIndex(other => other.href === link.href) === index),
  };
}
