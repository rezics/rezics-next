import { isView } from '@rezics/composition';
import type { CoverSummary } from '@rezics/ui/cover';
import { validVariant } from '../../media/cover-src';
import { publicCardImage, type PublicCardImage } from '../../media/public-card';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { originalLanguage } from '../../subject/language';
import { pageHead, type PagePaths } from '../../shell/head';
import { shareCardImage } from '../../shell/share-card';
import type { ShareCardProjection } from '../../media/share-card';
import type { AccountProfile } from './account-read';
import { agentPath, pageProfile } from './agent';
import { subjectRead, type SubjectPageData } from './subject';
import type { AccountView } from '../../accounts/public-profile/page-read';
import { isRecord, pageText, webUrl } from './shared';

export type AgentPage = SubjectPageData & { account: NonNullable<SubjectPageData['account']> };

/** Only named views have a path; the overview is the agent's base address. */
export function agentPathView(value: unknown): AccountView | undefined {
  return value === 'realms'
    ? value
    : typeof value === 'string' && isView(value) && value !== 'overview'
      ? value
      : undefined;
}

/** A named route exists only when the public overview exposed that tab. */
export function agentViewAvailable(tabs: readonly { view: string }[], view: AccountView): boolean {
  return tabs.some((tab) => tab.view === view);
}

/** Every locale points to the matching agent page or matching view. */
export function agentPagePaths(handle: string, view?: AccountView): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => [locale, agentPath(locale, handle, view).slice(`/${locale}`.length)]),
  ) as PagePaths;
}

function displayName(page: AgentPage, profile: AccountProfile | undefined): string {
  return profile?.displayName || profile?.handle || page.account.handle;
}

type CardImage = PublicCardImage;

function coverImage(summary: unknown, alt: string): CardImage | undefined {
  if (
    !isRecord(summary) ||
    summary.withheld ||
    typeof summary.media !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(summary.media) ||
    typeof summary.width !== 'number' ||
    !Number.isFinite(summary.width) ||
    summary.width <= 0 ||
    typeof summary.height !== 'number' ||
    !Number.isFinite(summary.height) ||
    summary.height <= 0
  )
    return;
  const variants = Array.isArray(summary.variants)
    ? summary.variants.filter(
        (variant): variant is { format: 'avif' | 'webp'; width: number } =>
          isRecord(variant) &&
          (variant.format === 'avif' || variant.format === 'webp') &&
          typeof variant.width === 'number' &&
          validVariant(`${variant.format}-${variant.width}`),
      )
    : [];
  const image = publicCardImage({ ...summary, variants } as CoverSummary, alt);
  if (!image) return;
  // Divide before scaling so large finite source dimensions can still describe a usable ratio.
  const height = Math.max(1, Math.round((summary.height / summary.width) * image.width));
  return Number.isFinite(height) ? { ...image, height } : undefined;
}

function cardImageFor(page: AgentPage, profile: AccountProfile | undefined, name: string): CardImage | undefined {
  if (profile?.avatar) {
    const avatar = coverImage(profile.avatar, name);
    if (avatar) return avatar;
  }
  const subject = subjectRead(page);
  const summary = subject?.body.summary;
  return isRecord(summary) ? coverImage(summary.cover, name) : undefined;
}

function absoluteImage(image: CardImage | undefined, origin: string): string | undefined {
  if (
    !image ||
    !Number.isFinite(image.width) ||
    image.width <= 0 ||
    !Number.isFinite(image.height) ||
    image.height <= 0
  )
    return;
  try {
    const url = new URL(image.url, `${origin}/`);
    if (url.origin !== origin) return;
    if (url.pathname.startsWith('/media/')) {
      const path = /^\/media\/[A-Za-z0-9_-]+\/([^/]+)$/.exec(url.pathname);
      if (!path || !validVariant(path[1]!)) return;
    }
    return url.href;
  } catch {
    return;
  }
}

function sameAs(profile: AccountProfile | undefined): string[] | undefined {
  const links = [...new Set((profile?.links ?? []).filter((link) => webUrl(link.url)).map((link) => link.url))];
  return links.length > 0 ? links : undefined;
}

function breadcrumbs(title: string, canonical: string, origin: string, locale: Locale) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'REZICS',
        item: `${origin}/${locale}`,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: title,
        item: canonical,
      },
    ],
  };
}

/** Build the profile and breadcrumb graph from the public identity reads used by the page. */
export function agentPageHead(
  page: AgentPage,
  locale: Locale,
  origin: string,
  paths: PagePaths = agentPagePaths(page.account.handle),
  _view?: AccountView,
  cursor?: string,
  shareCard?: ShareCardProjection,
) {
  const profile = pageProfile(page);
  const handle = profile?.handle ?? page.account.handle;
  const name = displayName(page, profile);
  const title = `${name} (@${handle})`;
  const path = paths[locale] ?? agentPagePaths(handle)[locale];
  const canonical = `${origin.replace(/\/+$/, '')}/${locale}${path}`;
  const selected = subjectRead(page);
  const description = selected
    ? pageText(selected.subject.descriptions, locale, originalLanguage(selected.subject)).text
    : '';
  const image = cardImageFor(page, profile, name);
  const entityImage = absoluteImage(image, origin);
  const nextImage = image ?? shareCardImage(shareCard);
  const publishedLinks = sameAs(profile);
  const entity = {
    '@type': profile?.kind === 'organization' ? 'Organization' : profile?.automated ? 'SoftwareApplication' : 'Person',
    name,
    alternateName: handle,
    url: `${origin.replace(/\/+$/, '')}/${locale}${agentPath(locale, handle).slice(`/${locale}`.length)}`,
    ...(description ? { description } : {}),
    ...(entityImage ? { image: entityImage } : {}),
    ...(publishedLinks ? { sameAs: publishedLinks } : {}),
  };
  const head = pageHead(
    {
      title,
      ...(description ? { description } : {}),
      type: 'profile',
      image: absoluteImage(nextImage, origin) ? nextImage : shareCardImage(),
      ...(cursor ? { robots: 'noindex, follow' } : {}),
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'ProfilePage',
            name: title,
            url: canonical,
            mainEntity: entity,
          },
          breadcrumbs(title, canonical, origin.replace(/\/+$/, ''), locale),
        ],
      },
    },
    { origin, locale, path, paths },
  );
  return {
    ...head,
    meta: [...head.meta, { property: 'profile:username', content: handle }],
  };
}
