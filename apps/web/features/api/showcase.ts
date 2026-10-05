import type { MainClient } from '../discover/types.ts';
import { mainApiWithToken } from './main.ts';

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

/** At most five configured picks need a header when the feed's bounded window does not contain them. */
export async function readShowcaseHeaders(
  targets: readonly string[],
): Promise<ReadonlyMap<string, WorkHeader>> {
  const wanted = showcaseTargets(targets);
  if (wanted.length > 5) throw new Error('Showcase header bound exceeded');
  const main = mainApiWithToken(undefined);
  const items = await Promise.all(
    wanted.map(async (target) => {
      try {
        const { data, error } = await main.v1.works({ id: target.slice(-36) }).get({ query: {} });
        return data && !error ? ([target, data] as const) : null;
      } catch {
        return null;
      }
    }),
  );
  return new Map(items.filter((item): item is NonNullable<typeof item> => item !== null));
}

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
export function readOwnWorkShowcase(work: string): Promise<ReadonlyMap<string, WorkShowcase>> {
  return readShowcaseBatch([work]);
}

async function readShowcaseBatch(
  targets: readonly string[],
  context?: string,
): Promise<ReadonlyMap<string, WorkShowcase>> {
  const wanted = showcaseTargets(targets);
  if (!wanted.length) return new Map();
  try {
    const { data, error } = await mainApiWithToken(undefined).v1.resources.showcase.post({
      profile: 'work-showcase-batch-v1',
      targets: wanted,
      ...(context ? { context } : {}),
    });
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
): Promise<ReadonlyMap<string, WorkSummary>> {
  const wanted = showcaseTargets(targets);
  if (!wanted.length) return new Map();
  try {
    const { data, error } = await mainApiWithToken(undefined).v1.resources.summaries.post({
      profile: 'resource-summary-batch-v1',
      resources: wanted,
      context,
    });
    if (error || !data || !data.complete) return new Map();
    const admitted = new Set(wanted);
    return new Map(
      data.summaries.flatMap((item) =>
        item.status === 'available' && item.type === 'work' && admitted.has(item.reference)
          ? [[item.reference, item]]
          : [],
      ),
    );
  } catch {
    return new Map();
  }
}
