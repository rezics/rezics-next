import { createKernelClient, type Kernel } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { libraryEntryStateWrite } from './entries-read';
import type { LibraryEntryStateWrite } from './entries-read';
import { commonShelfStates, selectableEntry, type ShelfSelectionCandidate } from './shelf-selection';

// These preflight limits mirror the mounted native command. Native admission remains authoritative.
export const bulkStatusTargetLimit = 1_000;
export const bulkStatusCommandByteLimit = 64 * 1024;

export type BulkStatusPreviewRequest = Readonly<{
  action: 'set_status';
  state: LibraryEntryStateWrite;
  selection: Readonly<{
    kind: 'explicit';
    targets: readonly Readonly<{ subjectId: string }>[];
  }>;
}>;

export type BulkStatusPreviewCapture =
  | Readonly<{
      ok: true;
      request: BulkStatusPreviewRequest;
      body: string;
      byteLength: number;
      subjects: readonly string[];
    }>
  | Readonly<{
      ok: false;
      reason:
        | 'empty_selection'
        | 'unsupported_selection'
        | 'status_incompatible'
        | 'too_many_targets'
        | 'command_too_large';
    }>;

type KernelRoutes = Kernel['~Routes']['v1'];
type NativePreviewRequest = KernelRoutes['libraryOperations']['post']['body'];
export type BulkStatusOperation =
  KernelRoutes['libraryOperations'][':operationId']['get']['response'][200]['operation'];
export type BulkStatusTargetOutcome =
  KernelRoutes['libraryOperations'][':operationId']['outcomes']['get']['response'][200]['outcomes'][number];

export type BulkStatusPreviewCall = Readonly<{
  body: string;
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
}>;
export type BulkStatusConfirmCall = BulkStatusPreviewCall & Readonly<{ operationId: string }>;
export type BulkStatusReadCall = Readonly<{
  headers: Readonly<Record<string, string>>;
  operationId: string;
}>;
export type BulkStatusReadResult = Readonly<{
  operation: BulkStatusOperation;
  outcomes: readonly BulkStatusTargetOutcome[];
}>;

export type BulkStatusSender = Readonly<{
  preview: (call: BulkStatusPreviewCall) => Promise<BulkStatusOperation>;
  confirm: (call: BulkStatusConfirmCall) => Promise<BulkStatusOperation>;
  read: (call: BulkStatusReadCall) => Promise<BulkStatusReadResult>;
}>;

export type BulkStatusManifest = Readonly<{
  preview: BulkStatusPreviewCall;
  confirm: Omit<BulkStatusPreviewCall, 'idempotencyKey'> & Readonly<{ idempotencyKey: string }>;
  readHeaders: Readonly<Record<string, string>>;
  sender: BulkStatusSender;
}>;

export type BulkStatusSelectionItem = Readonly<{
  subjectId: string;
  state: string;
  revision: number;
  changeKey: string;
  incarnationId?: string;
}>;

export function bulkStatusSelectionSignature(
  items: readonly BulkStatusSelectionItem[],
  requestedState: string,
): string {
  return JSON.stringify([
    requestedState,
    items.map(({ subjectId, state, revision, changeKey, incarnationId }) => [
      subjectId,
      state,
      revision,
      changeKey,
      incarnationId ?? null,
    ]),
  ]);
}

export function bulkStatusReviewMatches(
  expectedSignature: string,
  items: readonly BulkStatusSelectionItem[],
  requestedState: string,
  reviewLocale: string,
  currentLocale: string,
  current: boolean,
): boolean {
  return current && reviewLocale === currentLocale && expectedSignature === bulkStatusSelectionSignature(items, requestedState);
}

export type BulkStatusOutcomeGroups = Readonly<{
  applied: readonly BulkStatusTargetOutcome[];
  noChange: readonly BulkStatusTargetOutcome[];
  conflicts: readonly BulkStatusTargetOutcome[];
  skipped: readonly BulkStatusTargetOutcome[];
  failed: readonly BulkStatusTargetOutcome[];
  pending: readonly BulkStatusTargetOutcome[];
}>;

export function groupBulkStatusOutcomes(outcomes: readonly BulkStatusTargetOutcome[]): BulkStatusOutcomeGroups {
  return {
    applied: outcomes.filter((outcome) => outcome.state === 'applied'),
    noChange: outcomes.filter((outcome) => outcome.state === 'no_effect'),
    conflicts: outcomes.filter((outcome) => outcome.state === 'conflict'),
    skipped: outcomes.filter((outcome) => outcome.state === 'denied' || outcome.state === 'cancelled'),
    failed: outcomes.filter((outcome) => outcome.state === 'failed'),
    pending: outcomes.filter((outcome) => outcome.state === 'pending' || outcome.state === 'reconciling'),
  };
}

/** Capture the explicit loaded subjects and status that the native preview will persist. */
export function captureBulkStatusPreview(
  entries: readonly ShelfSelectionCandidate[],
  requestedState: string,
): BulkStatusPreviewCapture {
  if (!entries.length) return { ok: false, reason: 'empty_selection' };
  if (
    entries.some(
      (entry) => !selectableEntry(entry) || !entry.subject || !entry.subjectId || entry.subject.id !== entry.subjectId,
    )
  )
    return { ok: false, reason: 'unsupported_selection' };

  const state = libraryEntryStateWrite(requestedState);
  const commonStates = commonShelfStates(entries);
  if (!state || !commonStates.some((choice) => choice.id === state))
    return { ok: false, reason: 'status_incompatible' };

  const subjects = [...new Set(entries.map((entry) => entry.subject!.id))];
  if (subjects.length > bulkStatusTargetLimit) return { ok: false, reason: 'too_many_targets' };

  const targets = Object.freeze(subjects.map((subjectId) => Object.freeze({ subjectId })));
  const request: BulkStatusPreviewRequest = Object.freeze({
    action: 'set_status',
    state,
    selection: Object.freeze({ kind: 'explicit', targets }),
  });
  const body = JSON.stringify(request);
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > bulkStatusCommandByteLimit) return { ok: false, reason: 'command_too_large' };

  return Object.freeze({ ok: true, request, body, byteLength, subjects: Object.freeze(subjects) });
}

export function createBulkStatusManifest(
  captured: Extract<BulkStatusPreviewCapture, { ok: true }>,
  headers: Readonly<Record<string, string>>,
  sender: BulkStatusSender = bulkStatusSender,
): BulkStatusManifest {
  const capturedHeaders = Object.freeze({ ...headers });
  return Object.freeze({
    preview: Object.freeze({ body: captured.body, headers: capturedHeaders, idempotencyKey: crypto.randomUUID() }),
    confirm: Object.freeze({ body: '{}', headers: capturedHeaders, idempotencyKey: crypto.randomUUID() }),
    readHeaders: capturedHeaders,
    sender,
  });
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
  return { client: createKernelClient(origin, { headers: { authorization } }) };
}

function responseData<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) throw new Error('The native Shelf operation could not be read.');
  return result.data;
}

const previewNativeBulkStatus = createServerFn({ method: 'POST', strict: false })
  .validator((data: BulkStatusPreviewCall) => data)
  .handler(async ({ data }) => {
    const { client } = await nativeClient(data.headers);
    const result = await client.libraryOperations.post(
      JSON.parse(data.body) as NativePreviewRequest,
      { headers: { 'idempotency-key': data.idempotencyKey } },
    );
    return responseData(result).operation as BulkStatusOperation;
  });

const confirmNativeBulkStatus = createServerFn({ method: 'POST', strict: false })
  .validator((data: BulkStatusConfirmCall) => data)
  .handler(async ({ data }) => {
    const { client } = await nativeClient(data.headers);
    const result = await client
      .libraryOperations({ operationId: data.operationId })
      .$confirm.post(JSON.parse(data.body) as object, {
        headers: { 'idempotency-key': data.idempotencyKey },
      });
    return responseData(result).operation;
  });

const readNativeBulkStatus = createServerFn({ method: 'GET', strict: false })
  .validator((data: BulkStatusReadCall) => data)
  .handler(async ({ data }): Promise<BulkStatusReadResult> => {
    const { client } = await nativeClient(data.headers);
    const operation = responseData(await client.libraryOperations({ operationId: data.operationId }).get()).operation;
    const outcomes: BulkStatusTargetOutcome[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const query = cursor ? { limit: 100, cursor } : { limit: 100 };
      const page = responseData(
        await client
          .libraryOperations({ operationId: data.operationId })
          .outcomes.get({ query }),
      );
      outcomes.push(...page.outcomes);
      cursor = page.next;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    } while (cursor);
    return { operation, outcomes };
  });

/** The operation object keeps one sender and exact request metadata for uncertain confirmation recovery. */
export const bulkStatusSender: BulkStatusSender = {
  preview: (call) => previewNativeBulkStatus({ data: call, headers: new Headers(call.headers) }),
  confirm: (call) => confirmNativeBulkStatus({ data: call, headers: new Headers(call.headers) }),
  read: (call) => readNativeBulkStatus({ data: call, headers: new Headers(call.headers) }),
};
