import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  type MediaImportAccepted,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import { checkRequest } from './accepted-checks.ts';
import type { Owner, RecordBindings } from './record-bindings.ts';

/** Public JSON operations; the caller supplies authorization and bounded HTTP transport. */
export interface MediaImportPort {
  readFence(
    tuple: { source: string; externalId: string; fieldGroup: 'cover' },
    signal: AbortSignal,
  ): Promise<{ fenced: boolean; securityRevision: string | null }>;
  /** Send these journal bytes unchanged as the POST body, with this Idempotency-Key. */
  importFromUrl(bytes: string, key: string, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  importStatus(id: string, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

export interface ResolveMediaInput {
  owner: Owner;
  containerId: string;
  mediaImportIntents: readonly MediaImportRequest[];
  signal: AbortSignal;
  /** Submit missing jobs without polling; the coordinator owns the later media pass. */
  deferPending?: boolean;
}

export type MediaResolution =
  | { outcome: 'fenced'; securityRevision: string; mediaIds: Record<string, never> }
  | {
      outcome: 'resolved';
      mediaIds: Record<string, string>;
      assets: { sourceUrl: string; key: string; outcome: 'available' | 'pending' | 'rejected' }[];
    };

export interface MediaResolver {
  resolve(input: ResolveMediaInput): Promise<MediaResolution>;
}

export interface MediaResolverOptions {
  bindings: RecordBindings;
  port: MediaImportPort;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Retained for compatibility; one GET is made per invocation and no inline wait occurs. */
  pollAttempts?: number;
  pollDelayMs?: number;
}

const BYTES = 65536;
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Invalid media resolution');
}

/** Inspect data descriptors before serialization or portable validation can run user code. */
function snapshot<T>(input: T): T {
  let budget = BYTES;
  let nodes = 0;
  const ancestors = new Set<object>();
  const charge = (value: string) => {
    // Avoid walking an already oversized string to compute its UTF-8 length.
    ensure(value.length <= budget);
    budget -= Buffer.byteLength(value);
    ensure(budget >= 0);
  };
  function visit(value: unknown, depth: number): unknown {
    ensure(depth <= 32 && ++nodes <= BYTES);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      charge(value);
      return value;
    }
    if (typeof value === 'number') {
      ensure(Number.isFinite(value));
      return value;
    }
    ensure(typeof value === 'object' && !types.isProxy(value) && !ancestors.has(value));
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    ensure(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')!;
      ensure('value' in length && Number.isInteger(length.value) && length.value <= BYTES);
    }
    const keys = Reflect.ownKeys(value);
    ensure(keys.length <= BYTES);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    ancestors.add(value);
    let items = 0;
    // Canonical object order makes keys and journal bytes independent of member insertion order.
    if (!array) keys.sort();
    for (const key of keys) {
      ensure(typeof key === 'string' && key !== 'toJSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      ensure('value' in descriptor);
      if (array && key === 'length') continue;
      ensure(descriptor.enumerable);
      if (array) ensure(key === String(items++));
      charge(key);
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    if (array) ensure(items === Object.getOwnPropertyDescriptor(value, 'length')!.value);
    ancestors.delete(value);
    return result;
  }
  const value = visit(input, 0) as T;
  ensure(Buffer.byteLength(JSON.stringify(value)) <= BYTES);
  return value;
}

function ownValue(input: object, name: string): unknown {
  ensure(input !== null && typeof input === 'object' && !types.isProxy(input));
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  ensure(descriptor && 'value' in descriptor);
  return descriptor.value;
}

/**
 * Resolve only the supplied bounded assets, using exact indexed journals rather than cover_key.
 * RecordBindings validates and durably stores actual receipts/statuses before we use them.
 * A resolved envelope can still contain unfinished assets; it never advances a source baseline.
 */
export function createMediaResolver(options: MediaResolverOptions): MediaResolver {
  const { bindings, port } = options;
  const attempts = options.pollAttempts ?? 5;
  const delay = options.pollDelayMs ?? 1000;
  ensure(Number.isInteger(attempts) && attempts >= 1 && attempts <= 5);
  ensure(Number.isFinite(delay) && delay >= 0 && delay <= 1000);

  return {
    async resolve(input) {
      const owner = snapshot(ownValue(input, 'owner')) as Owner;
      ensure(owner && typeof owner.source === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(owner.source));
      ensure(typeof owner.external_id === 'string' && owner.external_id.length > 0);
      const containerId = ownValue(input, 'containerId');
      ensure(typeof containerId === 'string');
      const signal = ownValue(input, 'signal') as AbortSignal;
      const deferPending = Object.hasOwn(input, 'deferPending') ? ownValue(input, 'deferPending') : false;
      ensure(typeof deferPending === 'boolean');
      signal.throwIfAborted();
      const supplied = ownValue(input, 'mediaImportIntents');
      ensure(Array.isArray(supplied) && !types.isProxy(supplied));
      const length = ownValue(supplied, 'length');
      ensure(typeof length === 'number' && length <= 64);
      const urls = new Set<string>();
      // Validate every asset before any fence or media call. Each has its own 64KiB budget.
      const assets = Array.from({ length }, (_, index) => {
        const request = snapshot(ownValue(supplied, String(index))) as MediaImportRequest;
        ensure(checkRequest(request).length === 0);
        ensure(
          request.containerId === containerId &&
            request.provenance.source === owner.source &&
            request.provenance.external_id === owner.external_id,
        );
        ensure(!urls.has(request.sourceUrl));
        urls.add(request.sourceUrl);
        const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const key = `${owner.source}:${owner.external_id}:${signature}`;
        ensure(Buffer.byteLength(key) <= 255 && /^[\x20-\x7e]+$/.test(key));
        return { request, signature, key };
      });
      const claim = bindings.claim(owner);
      ensure(claim?.state === 'bound' && claim.subject === containerId);
      signal.throwIfAborted();
      const fence = snapshot(
        await port.readFence({ source: owner.source, externalId: owner.external_id, fieldGroup: 'cover' }, signal),
      );
      signal.throwIfAborted();
      ensure(fence && typeof fence.fenced === 'boolean');
      if (fence.fenced) {
        ensure(typeof fence.securityRevision === 'string' && fence.securityRevision.length > 0);
        return { outcome: 'fenced', securityRevision: fence.securityRevision, mediaIds: {} };
      }
      ensure(fence.securityRevision === null);

      const result: Extract<MediaResolution, { outcome: 'resolved' }> = {
        outcome: 'resolved',
        mediaIds: {},
        assets: [],
      };
      // Sequential processing bounds live state and in-flight operations independently of history.
      for (const { request, signature, key } of assets) {
        signal.throwIfAborted();
        const journal = bindings.mediaPending(owner, key) ?? bindings.prepareMedia(owner, key, signature, request);
        ensure(journal.signature === signature && journal.bytes === JSON.stringify(request));
        let accepted = journal.accepted;
        let submitted = false;
        if (!accepted) {
          const response = await port.importFromUrl(journal.bytes, journal.key, signal);
          ensure(ownValue(response, 'status') === 202);
          const receipt = snapshot(ownValue(response, 'body')) as MediaImportAccepted;
          // Validation belongs to the durable boundary; failure leaves the prepared POST replayable.
          bindings.acceptMedia(owner, key, receipt);
          accepted = receipt;
          submitted = true;
        }
        let status = journal.status;
        if (status?.media.state !== 'rejected' && status?.media.state !== 'available' && !(deferPending && submitted)) {
          signal.throwIfAborted();
          const response = await port.importStatus(accepted.media.id, signal);
          ensure(ownValue(response, 'status') === 200);
          const observation = snapshot(ownValue(response, 'body')) as MediaImportStatus;
          bindings.observeMedia(owner, key, observation);
          status = observation;
        }
        signal.throwIfAborted();
        const state = status?.media.state;
        const outcome = state === 'available' || state === 'rejected' ? state : 'pending';
        if (outcome === 'available') result.mediaIds[request.sourceUrl] = status!.media.id;
        result.assets.push({ sourceUrl: request.sourceUrl, key, outcome });
      }
      return result;
    },
  };
}
