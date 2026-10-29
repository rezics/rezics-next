import { isView, planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import type { CoverSummary } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { originalLanguage } from '../../subject/language';
import type { Subject } from '../../subject/types';
import { pageHead, type PagePaths } from '../../shell/head';
import { accountOf, type AccountProfile } from './account-read';
import { agentPath } from './agent';
import { pageContext, type SubjectPageData } from './subject';
import { isRecord, pageText, webUrl } from './shared';

export type AgentPage = SubjectPageData & { account: NonNullable<SubjectPageData['account']> };

/** Only named views have a path; the overview is the agent's base address. */
export function agentPathView(value: unknown): View | undefined {
  return typeof value === 'string' && isView(value) && value !== 'overview' ? value : undefined;
}

/** A named route exists only when the public overview exposed that tab. */
export function agentViewAvailable(tabs: readonly { view: string }[], view: View): boolean {
  return tabs.some((tab) => tab.view === view);
}

/** Every locale points to the matching agent page or matching view. */
export function agentPagePaths(handle: string, view?: View): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => [locale, agentPath(locale, handle, view).slice(`/${locale}`.length)]),
  ) as PagePaths;
}

function subjectRead(page: AgentPage): { subject: Subject; body: Record<string, unknown> } | undefined {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  const entry = Object.entries(reads).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = entry ? page.reads[entry[0]] : undefined;
  if (result?.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) return;
  return { subject: result.body.subject as unknown as Subject, body: result.body };
}

function profileRead(page: AgentPage): AccountProfile | undefined {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  const entry = Object.entries(reads).find(([, read]) => read.kind === 'account');
  const result = entry ? page.reads[entry[0]] : undefined;
  return result?.status === 200 ? accountOf(result.body) : undefined;
}

function displayName(page: AgentPage, profile: AccountProfile | undefined): string {
  return profile?.displayName || profile?.handle || page.account.handle;
}

type CardImage = { url: string; width: number; height: number; alt: string };

function coverImage(summary: unknown, alt: string): CardImage | undefined {
  if (!isRecord(summary) || summary.withheld || typeof summary.media !== 'string') return;
  const variants = Array.isArray(summary.variants)
    ? summary.variants.filter(
        (variant): variant is { format: 'avif' | 'webp'; width: number } =>
          isRecord(variant) &&
          (variant.format === 'avif' || variant.format === 'webp') &&
          typeof variant.width === 'number' &&
          Number.isFinite(variant.width) &&
          variant.width > 0,
      )
    : [];
  const widths = [...new Set(variants.map((variant) => variant.width))].sort(
    (left, right) => Math.abs(left - 1200) - Math.abs(right - 1200) || right - left,
  );
  const width = widths[0];
  if (width === undefined) return;
  const variant =
    variants.find((item) => item.width === width && item.format === 'webp') ??
    variants.find((item) => item.width === width);
  if (!variant) return;
  const sourceWidth = typeof summary.width === 'number' && summary.width > 0 ? summary.width : width;
  const sourceHeight = typeof summary.height === 'number' && summary.height > 0 ? summary.height : sourceWidth;
  return {
    url: coverSrc(summary.media, variant.format, width),
    width,
    height: Math.max(1, Math.round((sourceHeight * width) / sourceWidth)),
    alt,
  };
}

function cardImageFor(page: AgentPage, profile: AccountProfile | undefined, name: string): CardImage | undefined {
  if (profile?.avatar) {
    const avatar = coverImage(profile.avatar as CoverSummary, name);
    if (avatar) return avatar;
  }
  const subject = subjectRead(page);
  const summary = subject?.body.summary;
  return isRecord(summary) ? coverImage(summary.cover, name) : undefined;
}

function absoluteImage(image: CardImage | undefined, origin: string): string {
  return new URL(image?.url ?? '/cards/default.png', `${origin}/`).href;
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
  _view?: View,
  cursor?: string,
) {
  const profile = profileRead(page);
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
  const entityImage = image ? absoluteImage(image, origin) : undefined;
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
      ...(image ? { image } : {}),
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
