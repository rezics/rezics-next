import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { Locale } from '../paraglide/runtime.js';

export const HOSTED_CHECKPOINT_LIMIT = 20;
export const HOSTED_CHECKPOINT_PREDECESSORS = 8;
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const cursor = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const revision = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,18}$/));
const address = v.strictObject({
  catalogueId: id,
  publicationRevisionId: id,
  occurrenceId: id,
  targetRevisionId: id,
  targetSha256: digest,
  documentPosition: v.nullable(
    v.strictObject({
      blockId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      offset: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2097152)),
    }),
  ),
});
const metadata = v.variant('availability', [
  v.strictObject({
    availability: v.literal('available'),
    occurrenceId: id,
    parentId: v.nullable(id),
    position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(511)),
    kind: v.literal('chapter'),
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    target: v.strictObject({ threadId: id, postId: id, revisionId: id, sha256: digest }),
  }),
  v.strictObject({
    availability: v.literal('unavailable'),
    occurrenceId: id,
    kind: v.picklist(['chapter', 'part', 'unknown']),
  }),
]);
/** Mirrors the landed native list contract, without importing Kernel implementation into Web. */
export const hostedCheckpointPageSchema = v.strictObject({
  items: v.pipe(
    v.array(
      v.strictObject({
        subjectId: id,
        revision,
        address,
        activityAt: v.string(),
        metadata,
      }),
    ),
    v.maxLength(HOSTED_CHECKPOINT_LIMIT),
  ),
  nextCursor: v.nullable(cursor),
});
export type HostedCheckpointPage = v.InferOutput<typeof hostedCheckpointPageSchema>;
export const hostedCheckpointViewerSchema = id;
export const hostedCheckpointCursorSchema = cursor;

export type HostedCheckpointItem =
  | { availability: 'unavailable'; subjectId: string; revision: string }
  | {
      availability: 'available';
      subjectId: string;
      revision: string;
      title: string;
      catalogueId: string;
      publicationRevisionId: string;
      occurrenceId: string;
    };
export type HostedCheckpointResult =
  | { state: 'loaded'; items: HostedCheckpointItem[]; nextCursor: string | null }
  | { state: 'signed-out' | 'denied' | 'stale' }
  | { state: 'unavailable'; reason?: 'client-pending' };
export type HostedCheckpointRequest = { viewer: string; locale: Locale; cursor?: string };
export type HostedCheckpointRead = (
  input: HostedCheckpointRequest,
  signal: AbortSignal,
) => Promise<HostedCheckpointResult>;
export type HostedCheckpointHref = (
  catalogueId: string,
  locale: Locale,
  search: { subject: string; release: string; occurrence: string; view: 'chapter' },
) => string;

/** Withheld metadata drops address operands too: presentation cannot accidentally create an open action. */
export function presentHostedCheckpoints(data: unknown): HostedCheckpointResult {
  const parsed = v.safeParse(hostedCheckpointPageSchema, data);
  if (!parsed.success) return { state: 'unavailable' };
  const items: HostedCheckpointItem[] = [];
  for (const row of parsed.output.items) {
    const { metadata, address } = row;
    if (metadata.occurrenceId !== address.occurrenceId) return { state: 'unavailable' };
    if (metadata.availability === 'unavailable') {
      items.push({ availability: 'unavailable', subjectId: row.subjectId, revision: row.revision });
    } else {
      if (metadata.target.revisionId !== address.targetRevisionId || metadata.target.sha256 !== address.targetSha256)
        return { state: 'unavailable' };
      items.push({
        availability: 'available',
        subjectId: row.subjectId,
        revision: row.revision,
        title: metadata.title,
        catalogueId: address.catalogueId,
        publicationRevisionId: address.publicationRevisionId,
        occurrenceId: address.occurrenceId,
      });
    }
  }
  return { state: 'loaded', items, nextCursor: parsed.output.nextCursor };
}

export function hostedCheckpointHref(
  item: Extract<HostedCheckpointItem, { availability: 'available' }>,
  locale: Locale,
  href: HostedCheckpointHref,
) {
  return href(item.catalogueId, locale, {
    subject: item.subjectId,
    release: item.publicationRevisionId,
    occurrence: item.occurrenceId,
    view: 'chapter',
  });
}

export type HostedCheckpointTransport = (
  client: KernelClient,
  options: {
    query: { limit: number; cursor?: string };
    headers: { authorization: string };
    fetch: { signal: AbortSignal; cache: 'no-store'; redirect: 'manual' };
  },
) => Promise<{ status: number; error: unknown; data: unknown }>;

/** One native list read; no per-Book resolution or fallback chapter reads. */
export async function readHostedCheckpointPage(
  client: KernelClient,
  authorization: string,
  input: { cursor?: string },
  signal: AbortSignal,
  transport?: HostedCheckpointTransport,
): Promise<HostedCheckpointResult> {
  signal.throwIfAborted();
  // The installed generated declaration predates the native checkpoints operation.
  // Keep the binding explicit until Client publishes the landed native list contract.
  if (!transport) return { state: 'unavailable', reason: 'client-pending' };
  const response = await transport(client, {
    query: { limit: HOSTED_CHECKPOINT_LIMIT, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
    headers: { authorization },
    fetch: { signal, cache: 'no-store', redirect: 'manual' },
  });
  signal.throwIfAborted();
  if (response.status === 401) return { state: 'signed-out' };
  if (response.status === 403) return { state: 'denied' };
  if (response.status === 400 || response.status === 409) return { state: 'stale' };
  if (response.status !== 200 || response.error) return { state: 'unavailable' };
  return presentHostedCheckpoints(response.data);
}
