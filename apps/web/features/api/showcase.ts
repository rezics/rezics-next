import type { MediaImageMetadata } from '@rezics/ui/media-image';
import { mediaImageKey } from '@rezics/ui/media-image-key';
import type { MainClient } from '../discover/types.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import type { AnonymousMainClient } from './main.ts';
import { browserMainApi } from './browser.ts';
import { imageReferenceFromUrl, mediaMetadataItems, mediaMetadataOf } from './media-metadata.ts';

type Result<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }>
  ? NonNullable<Data>
  : never;
export type ShowcaseBatch = Result<MainClient['v1']['resources']['showcase']['post']>;
type Available = Extract<ShowcaseBatch['items'][number], { status: 'available' }>;
/** Main's mapped literal unions currently infer `never` in Eden. Keep its admitted values at this boundary. */
export type ShowcaseImage = Omit<Available['images'][number], 'role' | 'anchor'> & {
  role: 'background-landscape' | 'background-portrait' | 'logo' | 'cutout';
  anchor?: 'start-bottom' | 'center-top' | 'center-middle' | 'center-bottom';
};
export type WorkShowcase = Omit<Available, 'images'> & { images: ShowcaseImage[] };
export type WorkSummaryBatch = Result<MainClient['v1']['resources']['summaries']['post']>;
export type WorkSummary = Extract<WorkSummaryBatch['summaries'][number], { status: 'available' }>;
type WorkHeader = Result<ReturnType<MainClient['v1']['works']>['get']>;
type AuthorCredits = Extract<Result<MainClient['v1']['query']['post']>['result'], {
  query: 'https://rezics.com/query/work-credits';
}>;
/** A summary alone cannot describe a Work card. Keep Main's complete card and public credit preview. */
export type ShowcaseWork = WorkHeader & {
  address: CanonicalAddress;
  primaryCredits: AuthorCredits['items'];
};

export function showcaseTargets(targets: readonly string[]): string[] {
  const unique = [...new Set(targets)];
  if (
    unique.length > 64 ||
    unique.some((target) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target))
  )
    throw new Error('Showcase batch targets are invalid');
  return unique;
}

/** Realm home reads remain public. The API decides visibility and contextual/default selection fallback. */
export async function readWorkShowcase(
  targets: readonly string[],
  context: string,
): Promise<ReadonlyMap<string, WorkShowcase>> {
  return readShowcaseBatch(targets, context);
}

/** A Work page reads the Work's own art, with no Zone or Realm context to override it. */
export function readOwnWorkShowcase(work: string, fetcher?: typeof fetch, anonymous?: AnonymousMainClient): Promise<ReadonlyMap<string, WorkShowcase>> {
  return readShowcaseBatch([work], undefined, fetcher, anonymous);
}

async function readShowcaseBatch(
  targets: readonly string[],
  context?: string,
  fetcher?: typeof fetch,
  anonymous?: AnonymousMainClient,
): Promise<ReadonlyMap<string, WorkShowcase>> {
  const wanted = showcaseTargets(targets);
  if (!wanted.length) return new Map();
  try {
    const body = {
      profile: 'work-showcase-batch-v1' as const,
      targets: wanted,
      ...(context ? { context } : {}),
    };
    const { data, error } = anonymous ? await anonymous.v1.resources.showcase.post(body) : fetcher
      ? await browserMainApi(undefined, { anonymous: true, fetcher }).v1.resources.showcase.post(body)
      : await (async () => {
        const { mainApiWithToken } = await import('./main.ts');
        return mainApiWithToken(undefined).v1.resources.showcase.post(body);
      })();
    if (error || !data || !data.complete) return new Map();
    const admitted = new Set(wanted);
    return new Map(
      data.items.flatMap((item) =>
        item.status === 'available' && admitted.has(item.reference) ? [[item.reference, item]] : [],
      ),
    );
  } catch {
    return new Map();
  }
}

/** Explicit picks need their actual public identity even when outside the feed's current window. */
export async function readShowcaseWorks(
  targets: readonly string[],
  context: string,
  anonymous?: AnonymousMainClient,
): Promise<ReadonlyMap<string, ShowcaseWork>> {
  const wanted = showcaseTargets(targets);
  if (!wanted.length) return new Map();
  try {
    if (!anonymous) {
      const { mainApiWithToken } = await import('./main.ts');
      return readShowcaseWorks(wanted, context, mainApiWithToken(undefined));
    }
    const { data, error } = await anonymous.v1.resources.summaries.post({
      profile: 'resource-summary-batch-v1',
      resources: wanted,
      ...(context ? { context } : {}),
    });
    if (error || !data || !data.complete) return new Map();
    const summaries = new Map(data.summaries.flatMap(item => item.status === 'available'
      && item.type === 'work' && wanted.includes(item.reference) ? [[item.reference, item] as const] : []));
    const works = new Map<string, ShowcaseWork>();
    // A bounded batch has at most four Works in flight. Missing/denied card or credit reads
    // remain unavailable; neither an empty type list nor an invented byline fills the gap.
    for (let offset = 0; offset < wanted.length; offset += 4) {
      await Promise.all(wanted.slice(offset, offset + 4).map(async target => {
        const summary = summaries.get(target);
        if (!summary) return;
        try {
          const [header, credits] = await Promise.all([
            anonymous.v1.works({ id: target.slice(-36) }).get({ query: {} }),
            anonymous.v1.query.post({ profile: 'template-query-v1',
              query: 'https://rezics.com/query/work-credits', revision: 1,
              parameters: { roots: [target], role: 'author' }, limit: 3 }),
          ]);
          const authors = credits.data?.result;
          if (header.error || !header.data || header.data.id !== target || credits.error
            || authors?.profile !== 'template-result-v1'
            || authors.query !== 'https://rezics.com/query/work-credits'
            || (!authors.complete && !authors.nextCursor)) return;
          // Match discovery's first three public authors. A real continuation admits this
          // bounded byline preview; an incomplete result without one cannot supply a card.
          works.set(target, { ...header.data, title: summary.name, cover: summary.avatar,
            address: summary.address as CanonicalAddress, primaryCredits: authors.items });
        } catch { /* The caller presents an unavailable region when a displayed Work is missing. */ }
      }));
    }
    return works;
  } catch {
    return new Map();
  }
}

/**
 * Metadata for the showcase images a page draws, read with the page so its HTML already holds each
 * image or its mask and the first slide's preload is used. Read anonymously: showcase art is public,
 * its labels do not depend on the reader, and the reader's preferences apply where it renders. An
 * image Main does not show anonymously is left to the reader's own client read. One batch of the
 * first 64 references, in the order given.
 */
export async function readShowcaseImages(
  urls: readonly string[],
): Promise<Record<string, MediaImageMetadata>> {
  const references = [
    ...new Map(
      urls.flatMap((url) => {
        const reference = imageReferenceFromUrl(url);
        return reference ? [[mediaImageKey(reference), reference] as const] : [];
      }),
    ).values(),
  ].slice(0, 64);
  if (!references.length) return {};
  try {
    const { mainApiWithToken } = await import('./main.ts');
    const { data, error } = await mainApiWithToken(undefined).v1.media.metadata.post({
      items: mediaMetadataItems(references),
    });
    if (error || !data) return {};
    return Object.fromEntries(
      mediaMetadataOf(data.items, references).map((item) => [item.requestKey!, item]),
    );
  } catch {
    return {};
  }
}
