import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { kernelClient } from '../../kernel/client';
import { localizedLabel } from '../../search/results';
import { isCatalogueHit, readDiscovery, type DiscoveryHit, type DiscoveryState } from '../../search/discovery';
import { locales } from '../../paraglide/runtime.js';
import { publicCollectionDiscoveryRequest, publicCollectionKind } from './request';

type DiscoveryFailure = Exclude<DiscoveryState, { status: 'ready' }>;

export type PublicCollectionSummary = Readonly<{
  id: string;
  title: string;
  titleLanguage?: string;
  description?: string;
  descriptionLanguage?: string;
}>;

export type PublicCollectionDiscoveryState =
  | { status: 'ready'; collections: PublicCollectionSummary[]; next: string | null }
  | { status: DiscoveryFailure['status'] };

export type PublicCollectionDiscoverySender = Parameters<typeof readDiscovery>[1];

function isCollectionHit(hit: DiscoveryHit): hit is Extract<DiscoveryHit, { summary: { kind: 'subject' } }> {
  return hit.key.kind === publicCollectionKind && isCatalogueHit(hit);
}

/** Admit the complete native page before projecting the disclosed Collection summaries. */
export async function readPublicCollectionPage(
  locale: string,
  cursor: string | undefined,
  send: PublicCollectionDiscoverySender,
): Promise<PublicCollectionDiscoveryState> {
  const { discovery } = await readDiscovery(publicCollectionDiscoveryRequest(locale, cursor), send);
  if (discovery.status !== 'ready') return { status: discovery.status };

  const collections: PublicCollectionSummary[] = [];
  for (const hit of discovery.page.hits) {
    if (!isCollectionHit(hit)) return { status: 'unavailable' };
    const summary = hit.summary.value;
    const title = localizedLabel(
      { ...(summary.label ? { [summary.label.language]: summary.label.value } : {}), ...(hit.labels ?? {}) },
      locale,
    );
    const description = localizedLabel(hit.descriptions ?? {}, locale);
    collections.push({
      id: hit.key.id,
      title: title.text,
      ...(title.lang ? { titleLanguage: title.lang } : {}),
      ...(description.text ? { description: description.text } : {}),
      ...(description.lang ? { descriptionLanguage: description.lang } : {}),
    });
  }

  return { status: 'ready', collections, next: discovery.page.next };
}

const inputSchema = v.object({
  locale: v.pipe(
    v.string(),
    v.check((value) => locales.some((locale) => locale === value)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
});

const readPublicCollectionDiscoveryWithLocale = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(inputSchema, input))
  .handler(async ({ data }) =>
    readPublicCollectionPage(data.locale, data.cursor, async (request) =>
      kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal: getRequest().signal } }),
    ),
  );

export function readPublicCollectionDiscovery({
  data,
  signal,
}: {
  data: { locale: string; cursor?: string };
  signal?: AbortSignal;
}) {
  return readPublicCollectionDiscoveryWithLocale({ data, ...(signal ? { signal } : {}) });
}
