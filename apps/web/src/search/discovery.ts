import * as v from 'valibot';
import type { KernelClient } from '@rezics/client';
import { readSearchPage } from './search-request';

// The adopted opt-in wire is not in the generated client yet. Validate it at the boundary;
// a legacy subjects response cannot stand in for a mixed result.
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
const subjectSummary = v.object({
  id: v.string(),
  type: v.string(),
  types: v.array(v.string()),
  label: v.nullable(v.object({ value: v.string(), language: v.string() })),
  creativeWork: v.boolean(),
  cover: v.nullable(cover),
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
const hit = v.union([
  v.object({
    key: v.object({ owner: v.literal('semantic'), kind: v.string(), route: v.number(), id: v.string() }),
    summary: v.object({ kind: v.literal('subject'), value: subjectSummary }),
  }),
  v.object({
    key: v.object({ owner: v.literal('accounts'), kind: v.literal('account'), route: v.number(), id: v.string() }),
    summary: v.object({ kind: v.literal('account'), value: accountSummary }),
  }),
]);
const count = v.union([
  v.object({ kind: v.string(), value: v.pipe(v.number(), v.integer(), v.minValue(0)), exact: v.literal(true) }),
  v.object({ kind: v.string(), value: v.pipe(v.number(), v.integer(), v.minValue(1)), exact: v.literal(false) }),
  v.object({ kind: v.string(), unavailable: v.literal(true) }),
]);
const page = v.object({
  hits: v.pipe(v.array(hit), v.maxLength(100)),
  kinds: v.object({
    values: v.array(v.object({ id: v.string(), labels: textMap, icon: v.string(), count: v.optional(count) })),
    next: v.nullable(v.string()),
  }),
  next: v.nullable(v.string()),
  as_of: v.string(),
});

export type DiscoveryPage = v.InferOutput<typeof page>;
export type DiscoveryHit = DiscoveryPage['hits'][number];
export type AccountDiscoverySummary = v.InferOutput<typeof accountSummary>;
export type DiscoveryRequest = Parameters<KernelClient['subjects']['$search']['post']>[0] & {
  representation: 'discovery-v1';
  languages: string[];
  descriptions?: boolean;
  properties?: string[];
};
export type DiscoveryState =
  | { status: 'loading' | 'unavailable' | 'not-ready' }
  | { status: 'ready'; page: DiscoveryPage };

export function discoveryKey(hit: DiscoveryHit): string {
  return `${hit.key.kind}:${hit.key.id}`;
}

/** Retain native order and identity. Missing summaries or mismatched owners fail the whole page. */
export function parseDiscoveryPage(value: object): DiscoveryPage | undefined {
  const parsed = v.safeParse(page, value);
  if (!parsed.success) return;
  const result = parsed.output;
  for (const hit of result.hits) {
    if (hit.key.id !== hit.summary.value.id) return;
    if (hit.summary.kind === 'subject' && hit.key.kind !== hit.summary.value.type) return;
  }
  if (new Set(result.hits.map(discoveryKey)).size !== result.hits.length) return;
  return result;
}

function notReady(error: object | null | undefined): boolean {
  if (!error) return false;
  if ('code' in error && error.code === 'index_not_ready') return true;
  return 'value' in error && typeof error.value === 'object' && error.value !== null && notReady(error.value);
}

/** One native mixed query; only the existing Top rated stale-cursor restart may send it again. */
export async function readDiscovery(
  request: DiscoveryRequest,
  send: (request: DiscoveryRequest) => Promise<{ status: number; data?: object | null; error?: object | null }>,
): Promise<{ discovery: DiscoveryState; restarted: boolean }> {
  let read: Awaited<ReturnType<typeof readSearchPage<Awaited<ReturnType<typeof send>>, DiscoveryRequest>>>;
  try {
    read = await readSearchPage(request, send);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { discovery: { status: 'unavailable' }, restarted: false };
  }
  const { response, restarted } = read;
  if (response.error || response.status !== 200)
    return { discovery: { status: notReady(response.error) ? 'not-ready' : 'unavailable' }, restarted };
  const result = response.data ? parseDiscoveryPage(response.data) : undefined;
  return { discovery: result ? { status: 'ready', page: result } : { status: 'unavailable' }, restarted };
}
