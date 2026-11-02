import { treaty } from '@elysia/eden';
import type { Kernel } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { Elysia } from 'elysia';
import { env } from 'cloudflare:workers';
import type { PersonalLibraryEntry } from './entries-read';
import type { ShelfRemovalIdentity } from './shelf-selection';
import { shelfRemovalSelectionSignature } from './shelf-selection';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export const bulkLibraryRemovalTargetLimit = 1_000;
export const bulkLibraryRemovalCommandByteLimit = 64 * 1024;

export type BulkLibraryRemovalPreviewRequest = Readonly<{
  action: 'remove_from_library';
  selection: Readonly<{
    kind: 'explicit';
    targets: readonly Readonly<{ subjectId: string }>[];
  }>;
}>;

export type BulkLibraryRemovalCandidate = Pick<
  PersonalLibraryEntry,
  'subjectId' | 'revision' | 'incarnationId' | 'removeKey'
> & {
  subject: Readonly<{ id: string }> | null;
};

type KernelRoutes = Kernel['~Routes']['v1'];
type OperationRoute = KernelRoutes['libraryOperations'][':operationId'];
export type BulkLibraryRemovalOperation = OperationRoute['get']['response'][200]['operation'];
export type BulkLibraryRemovalTargetOutcome =
  OperationRoute['outcomes']['get']['response'][200]['outcomes'][number];
export type BulkLibraryRemovalOutcomes = OperationRoute['outcomes']['get']['response'][200];
export type BulkLibraryRemovalReadResult = Readonly<{
  operation: BulkLibraryRemovalOperation;
  outcomes: readonly BulkLibraryRemovalTargetOutcome[];
}>;

export type BulkLibraryRemovalPreviewCapture =
  | Readonly<{
      ok: true;
      request: BulkLibraryRemovalPreviewRequest;
      body: string;
      byteLength: number;
      subjectIds: readonly string[];
      signature: string;
    }>
  | Readonly<{
      ok: false;
      reason: 'empty_selection' | 'unsupported_selection' | 'duplicate_target' | 'too_many_targets' | 'command_too_large';
    }>;

// Reject the whole loaded selection when it exceeds native limits; never submit a truncated target list.
export function captureBulkLibraryRemovalPreview(
  entries: readonly BulkLibraryRemovalCandidate[],
): BulkLibraryRemovalPreviewCapture {
  if (!entries.length) return { ok: false, reason: 'empty_selection' };
  if (
    entries.some(
      ({ subjectId, subject }) => !subjectId || !subject || subject.id !== subjectId,
    )
  )
    return { ok: false, reason: 'unsupported_selection' };

  const subjectIds = entries.map(({ subject }) => subject!.id);
  if (new Set(subjectIds).size !== subjectIds.length) return { ok: false, reason: 'duplicate_target' };
  if (subjectIds.length > bulkLibraryRemovalTargetLimit) return { ok: false, reason: 'too_many_targets' };

  const request: BulkLibraryRemovalPreviewRequest = Object.freeze({
    action: 'remove_from_library',
    selection: Object.freeze({
      kind: 'explicit',
      targets: Object.freeze(subjectIds.map((subjectId) => Object.freeze({ subjectId }))),
    }),
  });
  const body = JSON.stringify(request);
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > bulkLibraryRemovalCommandByteLimit) return { ok: false, reason: 'command_too_large' };

  return Object.freeze({
    ok: true,
    request,
    body,
    byteLength,
    subjectIds: Object.freeze(subjectIds),
    signature: shelfRemovalSelectionSignature(entries),
  });
}

export type BulkLibraryRemovalPreviewCall = Readonly<{
  request: BulkLibraryRemovalPreviewRequest;
  body: string;
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
}>;
export type BulkLibraryRemovalConfirmCall = Readonly<{
  body: object;
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
  operationId: string;
}>;
export type BulkLibraryRemovalReadCall = Readonly<{
  headers: Readonly<Record<string, string>>;
  operationId: string;
}>;

export type BulkLibraryRemovalSender = Readonly<{
  preview: (call: BulkLibraryRemovalPreviewCall) => Promise<BulkLibraryRemovalOperation>;
  confirm: (call: BulkLibraryRemovalConfirmCall) => Promise<BulkLibraryRemovalOperation>;
  read: (call: BulkLibraryRemovalReadCall) => Promise<BulkLibraryRemovalReadResult>;
}>;

export type BulkLibraryRemovalManifest = Readonly<{
  preview: BulkLibraryRemovalPreviewCall;
  confirm: Omit<BulkLibraryRemovalConfirmCall, 'operationId'>;
  readHeaders: Readonly<Record<string, string>>;
  sender: BulkLibraryRemovalSender;
}>;

export function createBulkLibraryRemovalManifest(
  captured: Extract<BulkLibraryRemovalPreviewCapture, { ok: true }>,
  headers: Readonly<Record<string, string>>,
  sender: BulkLibraryRemovalSender = bulkLibraryRemovalSender,
): BulkLibraryRemovalManifest {
  const capturedHeaders = Object.freeze({ ...headers });
  const confirmBody: object = Object.freeze({});
  return Object.freeze({
    preview: Object.freeze({
      request: captured.request,
      body: captured.body,
      headers: capturedHeaders,
      idempotencyKey: crypto.randomUUID(),
    }),
    confirm: Object.freeze({
      body: confirmBody,
      headers: capturedHeaders,
      idempotencyKey: crypto.randomUUID(),
    }),
    readHeaders: capturedHeaders,
    sender,
  });
}

export async function sendCapturedBulkLibraryRemovalConfirmation(
  manifest: BulkLibraryRemovalManifest,
  operationId: string,
  allowed: () => boolean,
): Promise<BulkLibraryRemovalOperation | null> {
  if (!allowed()) return null;
  return manifest.sender.confirm({ ...manifest.confirm, operationId });
}

export async function readCapturedBulkLibraryRemoval(
  manifest: BulkLibraryRemovalManifest,
  operationId: string,
  allowed: () => boolean,
): Promise<BulkLibraryRemovalReadResult | null> {
  if (!allowed()) return null;
  const result = await manifest.sender.read({ operationId, headers: manifest.readHeaders });
  return allowed() ? result : null;
}

export function bulkLibraryRemovalReviewMatches(
  expectedSignature: string,
  entries: readonly ShelfRemovalIdentity[],
  reviewLocale: string,
  currentLocale: string,
  current: boolean,
): boolean {
  return (
    current &&
    reviewLocale === currentLocale &&
    expectedSignature === shelfRemovalSelectionSignature(entries)
  );
}

export function outcomesForBulkLibraryRemovalTargets(
  targets: readonly Readonly<{ subjectId: string }>[],
  outcomes: readonly BulkLibraryRemovalTargetOutcome[],
): readonly BulkLibraryRemovalTargetOutcome[] {
  const expected = new Set(targets.map(({ subjectId }) => subjectId));
  return outcomes.filter(({ subjectId }) => expected.has(subjectId));
}

export function landedBulkLibraryRemovalEntries<Target extends ShelfRemovalIdentity>(
  targets: readonly Target[],
  outcomes: readonly BulkLibraryRemovalTargetOutcome[],
): readonly Target[] {
  const landed = new Set(
    outcomes
      .filter(
        ({ state, reason }) => state === 'applied' || (state === 'no_effect' && reason === 'missing_target'),
      )
      .map(({ subjectId }) => subjectId),
  );
  return targets.filter(({ subjectId }) => landed.has(subjectId));
}

/*
 * The received KernelClient declaration still narrows preview POST to set_status. This local Eden route seam
 * carries the dedicated remove_from_library body while reusing generated Kernel operation and outcome types.
 */
type NativeOperationResult = Readonly<{ operation: BulkLibraryRemovalOperation }>;
type NativeOutcomePage = BulkLibraryRemovalOutcomes;
type NativeLibraryOperationsRoute = {
  post: {
    body: BulkLibraryRemovalPreviewRequest;
    params: {};
    query: unknown;
    headers: { 'idempotency-key': string };
    response: { 201: NativeOperationResult };
  };
  ':operationId': {
    $confirm: {
      post: {
        body: object;
        params: { operationId: string };
        query: unknown;
        headers: { 'idempotency-key': string };
        response: { 200: NativeOperationResult };
      };
    };
    get: {
      body: unknown;
      params: { operationId: string };
      query: unknown;
      headers: unknown;
      response: { 200: NativeOperationResult };
    };
    outcomes: {
      get: {
        body: unknown;
        params: { operationId: string };
        query: { limit?: number; cursor?: string };
        headers: unknown;
        response: { 200: NativeOutcomePage };
      };
    };
  };
};
type NativeLibraryRoutes = Omit<KernelRoutes, 'libraryOperations'> & {
  libraryOperations: NativeLibraryOperationsRoute;
};
type NativeKernelRoutes = Omit<Kernel['~Routes'], 'v1'> & { v1: NativeLibraryRoutes };
type NativeKernelApp = Elysia<
  Kernel['~Prefix'],
  'local',
  Kernel['~Singleton'],
  Kernel['~Definitions'],
  Kernel['~Metadata'],
  NativeKernelRoutes
>;

function createNativeClient(origin: string, authorization: string) {
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/\/\$([a-z][A-Za-z0-9]*)$/, ':$1');
    if (path === url.pathname) return globalThis.fetch(input, init);
    url.pathname = path;
    return globalThis.fetch(input instanceof Request ? new Request(url, input) : url.href, init);
  };
  return treaty<NativeKernelApp>(origin, {
    fetcher,
    parseDate: false,
    headers: () => ({ authorization }),
  }).v1;
}

async function nativeClient(headers: Readonly<Record<string, string>>) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  if (headers['x-csrf-token'] !== request.headers.get('x-csrf-token'))
    throw new Error('Shelf operation request headers changed');
  if (await prepareSession(request, env as Partial<SessionEnv>)) throw new Error('Sign in to use Shelf operations');
  const authorization = viewerCredential(request);
  if (!authorization) throw new Error('Sign in to use Shelf operations');
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (!origin) throw new Error('KERNEL_ORIGIN is required for Shelf operations');
  return { client: createNativeClient(origin, authorization) };
}

function responseData<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) throw new Error('The native library removal operation could not be read.');
  return result.data;
}

const previewNativeBulkLibraryRemoval = createServerFn({ method: 'POST', strict: false })
  .validator((data: BulkLibraryRemovalPreviewCall) => data)
  .handler(async ({ data }) => {
    const { client } = await nativeClient(data.headers);
    const result = await client.libraryOperations.post(data.request, {
      headers: { 'idempotency-key': data.idempotencyKey },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return responseData(result).operation;
  });

const confirmNativeBulkLibraryRemoval = createServerFn({ method: 'POST', strict: false })
  .validator((data: BulkLibraryRemovalConfirmCall) => data)
  .handler(async ({ data }) => {
    const { client } = await nativeClient(data.headers);
    const result = await client.libraryOperations({ operationId: data.operationId }).$confirm.post(data.body, {
      headers: { 'idempotency-key': data.idempotencyKey },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return responseData(result).operation;
  });

const readNativeBulkLibraryRemoval = createServerFn({ method: 'GET', strict: false })
  .validator((data: BulkLibraryRemovalReadCall) => data)
  .handler(async ({ data }): Promise<BulkLibraryRemovalReadResult> => {
    const { client } = await nativeClient(data.headers);
    const operation = responseData(
      await client.libraryOperations({ operationId: data.operationId }).get({
        fetch: { cache: 'no-store', redirect: 'manual' },
      }),
    ).operation;
    const outcomes: BulkLibraryRemovalTargetOutcome[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const page = responseData(
        await client.libraryOperations({ operationId: data.operationId }).outcomes.get({
          query: cursor ? { limit: 100, cursor } : { limit: 100 },
          fetch: { cache: 'no-store', redirect: 'manual' },
        }),
      );
      outcomes.push(...page.outcomes);
      cursor = page.next;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    } while (cursor);
    return { operation, outcomes };
  });

export const bulkLibraryRemovalSender: BulkLibraryRemovalSender = {
  preview: (call) => previewNativeBulkLibraryRemoval({ data: call, headers: new Headers(call.headers) }),
  confirm: (call) => confirmNativeBulkLibraryRemoval({ data: call, headers: new Headers(call.headers) }),
  read: (call) => readNativeBulkLibraryRemoval({ data: call, headers: new Headers(call.headers) }),
};
