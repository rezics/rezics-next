import * as v from 'valibot';
import type { KernelClient } from '@rezics/client';
import { GLOBAL, PUBLIC_RATING_SCALE, QUESTION } from '../features/pages/subject-ratings';
import { readSearchPage } from './search-request';
import { isPlatformClosedError } from '../kernel/platform-closed';

type NativePage = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>,
  { subjects: unknown }
>;
type NativeHit = NativePage['subjects'][number];

// Keep the opt-in envelope separate from the generated Subject compatibility response.
// Validate unknown wire data before allowing it to reach the page.
const textMap = v.record(v.string(), v.string());
const cover = v.object({
  media: v.string(),
  width: v.number(),
  height: v.number(),
  placeholder: v.object({ thumbhash: v.string(), color: v.string() }),
  variants: v.array(v.object({ format: v.picklist(['avif', 'webp']), width: v.number() })),
  focalPoint: v.nullable(v.object({ x: v.number(), y: v.number() })),
  credit: v.nullable(
    v.object({
      rightsHolder: v.string(),
      via: v.exactOptional(v.object({ name: v.string(), url: v.string() })),
      license: v.exactOptional(v.string()),
    }),
  ),
});
const subjectSummary: v.GenericSchema<NonNullable<NativeHit['summary']>> = v.object({
  id: v.string(),
  type: v.string(),
  types: v.array(v.string()),
  label: v.nullable(v.object({ value: v.string(), language: v.string() })),
  creativeWork: v.boolean(),
  cover: v.nullable(
    v.object({
      ...cover.entries,
      credit: v.object({
        rightsHolder: v.string(),
        via: v.object({ name: v.string(), url: v.string() }),
        license: v.string(),
        obligations: v.array(v.string()),
      }),
    }),
  ),
});
const accountSummary = v.object({
  id: v.string(),
  accountKind: v.picklist(['actor', 'organization']),
  handle: v.nullable(v.string()),
  displayName: v.nullable(v.string()),
  automated: v.boolean(),
  operatorId: v.nullable(v.string()),
  avatar: v.nullable(cover),
  verifiedAgent: v.nullable(v.object({ id: v.string(), label: v.string(), type: v.string() })),
});
const fact: v.GenericSchema<NonNullable<NativeHit['facts']>[string][number]> = v.variant('kind', [
  v.object({ kind: v.literal('item'), id: v.string(), labels: textMap }),
  v.object({ kind: v.literal('time'), year: v.pipe(v.number(), v.integer()) }),
  v.object({ kind: v.literal('quantity'), amount: v.pipe(v.number(), v.finite()), unit: v.string() }),
  v.object({ kind: v.literal('code'), value: v.string() }),
]);
const displayRating = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(PUBLIC_RATING_SCALE.min),
  v.maxValue(PUBLIC_RATING_SCALE.max),
);
const figure: v.GenericSchema<NativeHit['figure']> = v.strictObject({
  questionId: v.literal(QUESTION),
  populationId: v.literal(GLOBAL),
  scale: v.strictObject({
    min: v.pipe(v.number(), v.integer()),
    max: v.pipe(v.number(), v.integer()),
    displayStep: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  count: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  state: v.picklist(['ready', 'insufficient_data', 'updating']),
  mean: v.nullable(displayRating),
  score: v.nullable(displayRating),
});
const catalogueFields = {
  labels: v.exactOptional(textMap),
  aliases: v.exactOptional(v.record(v.string(), v.array(v.string()))),
  descriptions: v.exactOptional(textMap),
  facts: v.exactOptional(v.record(v.string(), v.pipe(v.array(fact), v.maxLength(3)))),
  figure: v.exactOptional(figure),
  listPresentation: v.exactOptional(
    v.object({
      imageAspect: v.picklist(['portrait', 'landscape', 'square']),
      keyFacts: v.pipe(v.array(v.string()), v.maxLength(4)),
    }),
  ),
};
const legacyHit = v.object({
  id: v.string(),
  type: v.string(),
  summary: v.nullable(subjectSummary),
  ...catalogueFields,
  labels: textMap,
});
const legacyPage = v.object({
  subjects: v.pipe(v.array(legacyHit), v.maxLength(100)),
  next: v.nullable(v.string()),
  as_of: v.string(),
});
const hit = v.union([
  v.object({
    key: v.object({ owner: v.literal('semantic'), kind: v.string(), route: v.number(), id: v.string() }),
    summary: v.object({ kind: v.literal('subject'), value: subjectSummary }),
    ...catalogueFields,
  }),
  v.object({
    key: v.object({ owner: v.literal('accounts'), kind: v.literal('account'), route: v.number(), id: v.string() }),
    summary: v.object({ kind: v.literal('account'), value: accountSummary }),
  }),
]);
const count = v.union([
  v.object({
    kind: v.string(),
    value: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
    exact: v.literal(true),
  }),
  v.object({
    kind: v.string(),
    value: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
    exact: v.literal(false),
  }),
  v.object({ kind: v.string(), unavailable: v.literal(true) }),
]);
const kind = v.object({ id: v.string(), labels: textMap, icon: v.string(), count: v.exactOptional(count) });
const kinds = v.object({ values: v.pipe(v.array(kind), v.maxLength(8)), next: v.nullable(v.string()) });
const kindPage = v.object({ kinds, as_of: v.string() });
const page = v.object({
  hits: v.pipe(v.array(hit), v.maxLength(100)),
  kinds,
  next: v.nullable(v.string()),
  as_of: v.string(),
});

export type DiscoveryPage = v.InferOutput<typeof page>;
export type LegacySearchPage = v.InferOutput<typeof legacyPage>;
export type DiscoveryKinds = v.InferOutput<typeof kinds>;
export type DiscoveryHit = DiscoveryPage['hits'][number];
export type AccountDiscoverySummary = v.InferOutput<typeof accountSummary>;
export type DiscoveryRequest = Parameters<KernelClient['subjects']['$search']['post']>[0] & {
  representation: 'discovery-v1';
  languages: string[];
  descriptions?: boolean;
  properties?: string[];
  kindPage?: { limit: number; cursor?: string };
  kindCountLeaf?: number;
};
export type DiscoveryState =
  | {
      status:
        | 'loading'
        | 'unavailable'
        | 'not-ready'
        | 'preparing'
        | 'closed'
        | 'restart'
        | 'invalid'
        | 'unsupported'
        | 'denied';
    }
  | { status: 'ready'; page: DiscoveryPage };

export function discoveryKey(hit: DiscoveryHit): string {
  return `${hit.key.kind}:${hit.key.id}`;
}

/** Retain native order and identity. Missing summaries or mismatched owners fail the whole page. */
export function parseDiscoveryPage(value: unknown): DiscoveryPage | undefined {
  const parsed = v.safeParse(page, value);
  if (!parsed.success) return;
  const result = parsed.output;
  for (const hit of result.hits) {
    if (hit.key.id !== hit.summary.value.id) return;
    if (hit.summary.kind === 'subject' && hit.key.kind !== hit.summary.value.type) return;
  }
  if (new Set(result.hits.map(discoveryKey)).size !== result.hits.length || !validKinds(result.kinds)) return;
  return result;
}

function validKinds(value: DiscoveryKinds): boolean {
  return (
    new Set(value.values.map((kind) => kind.id)).size === value.values.length &&
    value.values.every((kind) => !kind.count || kind.count.kind === kind.id)
  );
}

/**
 * Preserve native order and nullable summaries. Incoherent evidence or repeated rendered keys
 * make the whole legacy page unavailable without synthesizing or fetching replacement rows.
 */
export function parseLegacySearchPage(value: unknown): LegacySearchPage | undefined {
  const parsed = v.safeParse(legacyPage, value);
  if (!parsed.success) return;

  const identities = new Set<string>();
  for (const { id, type, summary } of parsed.output.subjects) {
    if (summary !== null && (summary.id !== id || summary.type !== type)) {
      return;
    }

    const identity = `${type}:${id}`;
    if (identities.has(identity)) {
      return;
    }
    identities.add(identity);
  }
  return parsed.output;
}

function problemCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'value' in error ? problemCode(error.value) : undefined;
}

type Failure = Exclude<DiscoveryState, { status: 'ready' }>;
export function discoveryFailure(status: number, error: unknown): Failure {
  const code = problemCode(error);
  if (status === 409) return { status: 'restart' };
  if (code === 'platform_closed') return { status: 'closed' };
  if (code === 'index_not_ready' || code === 'semantic_not_ready') return { status: 'not-ready' };
  if (status === 202 || code === 'preparing') return { status: 'preparing' };
  if (status === 401 || status === 403) return { status: 'denied' };
  if (status === 422) return { status: 'unsupported' };
  if (status === 400) return { status: 'invalid' };
  return { status: 'unavailable' };
}

type Response = { status: number; data?: unknown; error?: unknown };
export type DiscoverySender = (request: DiscoveryRequest) => Promise<Response>;

/** One mixed query. Retain the explicit legacy rating restart without broadening other 409s. */
export async function readDiscovery(
  request: DiscoveryRequest,
  send: DiscoverySender,
): Promise<{ discovery: DiscoveryState; restarted: boolean }> {
  try {
    const { response, restarted } =
      request.sort === 'rating'
        ? await readSearchPage(request, send)
        : { response: await send(request), restarted: false };
    if (response.error || response.status !== 200)
      return { discovery: discoveryFailure(response.status, response.error ?? response.data), restarted };
    const result = parseDiscoveryPage(response.data);
    return { discovery: result ? { status: 'ready', page: result } : { status: 'unavailable' }, restarted };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { discovery: { status: isPlatformClosedError(error) ? 'closed' : 'unavailable' }, restarted: false };
  }
}

export type DiscoveryKindsState = Failure | { status: 'ready'; kinds: DiscoveryKinds };

/** A kind cursor selects metadata only on the same operation, without hit cursor or count requests. */
export async function readDiscoveryKinds(
  request: DiscoveryRequest,
  cursor: string,
  send: DiscoverySender,
): Promise<DiscoveryKindsState> {
  const {
    cursor: _hitCursor,
    kindCountLeaf: _count,
    limit: _limit,
    descriptions: _descriptions,
    properties: _properties,
    ...conditions
  } = request;
  try {
    const response = await send({ ...conditions, kindPage: { limit: 8, cursor } });
    if (response.error || response.status !== 200)
      return discoveryFailure(response.status, response.error ?? response.data);
    const parsed = v.safeParse(kindPage, response.data);
    if (
      !parsed.success ||
      !validKinds(parsed.output.kinds) ||
      parsed.output.kinds.next === cursor ||
      (parsed.success && parsed.output.kinds.next !== null && parsed.output.kinds.values.length === 0)
    )
      return { status: 'unavailable' };
    return {
      status: 'ready',
      kinds: {
        values: parsed.output.kinds.values.map(({ count: _count, ...metadata }) => metadata),
        next: parsed.output.kinds.next,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { status: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

export function isCatalogueHit(hit: DiscoveryHit): hit is Extract<DiscoveryHit, { summary: { kind: 'subject' } }> {
  return hit.summary.kind === 'subject';
}
