import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { kernelClient } from '../../kernel/client';
import { localizedLabel } from '../../search/results';
import {
  isCatalogueHit,
  readDiscovery,
  type DiscoveryHit,
  type DiscoveryState,
  type PublicCollectionSummary as NativePublicCollectionSummary,
} from '../../search/discovery';
import { locales } from '../../paraglide/runtime.js';
import { publicCollectionDiscoveryRequest, publicCollectionKind } from './request';
import type { PublicCollectionDirectoryAddress } from './address';

type DiscoveryFailure = Exclude<DiscoveryState, { status: 'ready' }>;

export type PublicCollectionSummary = Readonly<{
  id: string;
  title: string;
  titleLanguage?: string;
  description?: string;
  descriptionLanguage?: string;
  card?: NativePublicCollectionSummary['card'];
}>;

export type PublicCollectionDiscoveryState =
  | { status: 'ready'; collections: PublicCollectionSummary[]; next: string | null; asOf: string }
  | { status: DiscoveryFailure['status'] | 'invalid-selection' };

export type PublicCollectionDiscoverySender = Parameters<typeof readDiscovery>[1];

function isCollectionHit(hit: DiscoveryHit) {
  return hit.key.kind === publicCollectionKind && (hit.summary.kind === 'collection' || isCatalogueHit(hit));
}

/** Admit the complete native page before projecting the disclosed Collection summaries. */
export async function readPublicCollectionPage(
  locale: string,
  address: PublicCollectionDirectoryAddress,
  send: PublicCollectionDiscoverySender,
): Promise<PublicCollectionDiscoveryState> {
  const { discovery } = await readDiscovery(publicCollectionDiscoveryRequest(locale, address), send);
  if (discovery.status !== 'ready') return { status: discovery.status };
  if (discovery.page.next !== null && (!discovery.page.next.length || discovery.page.next.length > 4864))
    return { status: 'unavailable' };

  const collections: PublicCollectionSummary[] = [];
  for (const hit of discovery.page.hits) {
    if (!isCollectionHit(hit)) return { status: 'unavailable' };
    // Search already checks eligibility, source membership, card identity and the entire continuation.
    // Its native Collection summary is a separate branch from the Subject compatibility summary.
    if (hit.summary.kind === 'collection') {
      const summary = hit.summary.value;
      collections.push({
        id: hit.key.id,
        title: summary.title,
        ...(summary.description ? { description: summary.description } : {}),
        card: summary.card,
      });
      continue;
    }
    if (!isCatalogueHit(hit)) return { status: 'unavailable' };
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

  return { status: 'ready', collections, next: discovery.page.next, asOf: discovery.page.as_of };
}

const inputSchema = v.object({
  locale: v.pipe(
    v.string(),
    v.check((value) => locales.some((locale) => locale === value)),
  ),
  presentationKind: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  curator: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  ),
  subject: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  ),
  order: v.optional(v.picklist(['recent', 'popular'])),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
});

const readPublicCollectionDiscoveryWithLocale = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(inputSchema, input))
  .handler(async ({ data }) => {
    const address: PublicCollectionDirectoryAddress = {
      ...(data.presentationKind === undefined ? {} : { presentationKind: data.presentationKind }),
      ...(data.curator === undefined ? {} : { curator: data.curator }),
      ...(data.subject === undefined ? {} : { subject: data.subject }),
      ...(data.order === undefined ? {} : { order: data.order }),
      ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
    };
    return readPublicCollectionPage(data.locale, address, async (request) =>
      kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal: getRequest().signal } }),
    );
  });

export function readPublicCollectionDiscovery({
  data,
  signal,
}: {
  data: { locale: string } & PublicCollectionDirectoryAddress;
  signal?: AbortSignal;
}) {
  return readPublicCollectionDiscoveryWithLocale({ data, ...(signal ? { signal } : {}) });
}
