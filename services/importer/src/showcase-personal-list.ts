import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { KernelClient } from '@rezics/client';
import type { ShowcaseJournal } from './showcase-journal.ts';

type VndbSurface = KernelClient['libraryImports']['vndb'];
type PreviewResponse = Awaited<ReturnType<VndbSurface['$preview']['post']>>;
type UploadedVndb = ReturnType<VndbSurface>;
export type ShowcasePersonalListReview = Parameters<UploadedVndb['$review']['post']>[0];
export type ShowcasePersonalListSelection = Parameters<UploadedVndb['$apply']['post']>[0];
type Reviewed = NonNullable<Awaited<ReturnType<UploadedVndb['$review']['post']>>['data']>;
type Applied = NonNullable<Awaited<ReturnType<UploadedVndb['$apply']['post']>>['data']>;

export const developmentPersonalListScopes = [
  'library_entry:update',
  'library_entry:read',
  'library_entry:list',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
  'rating:vote',
] as const;
const EXPORT_BYTES = 2 * 1024 * 1024;
const PREVIEW_PATH = '/v1/libraryImports/vndb:preview';

export type ShowcasePersonalListIdentity = {
  origin: string;
  actor: { accountId: string; clientId: string };
  credential: { keyId: string };
};

export type ShowcasePersonalListUpload =
  | { state: 'uploaded'; uploadId: string; rows: number }
  | { state: 'unavailable'; code: string }
  | { state: 'refused'; code: string }
  | { state: 'unknown-delivery'; code: string };

/** External private input only; the native preview owns XML parsing and version admission. */
export async function readShowcasePersonalListExport(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > EXPORT_BYTES)
      throw new TypeError('VNDB export must be a nonempty owner-only regular file of at most 2 MiB');
    const bytes = Buffer.alloc(EXPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > EXPORT_BYTES || length !== info.size) throw new TypeError('VNDB export changed size while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

function preview(value: unknown): { uploadId: string; rows: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return typeof result.uploadId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.uploadId) &&
    Number.isSafeInteger(result.rows) &&
    Number(result.rows) >= 0 &&
    Number(result.rows) <= 5000
    ? { uploadId: result.uploadId, rows: Number(result.rows) }
    : null;
}

/** Uploads one private export through the signed-in person's generated Kernel client. */
export async function seedShowcasePersonalList(input: {
  client: KernelClient;
  journal: ShowcaseJournal;
  xml: string;
  identity: ShowcasePersonalListIdentity;
}): Promise<ShowcasePersonalListUpload> {
  const digest = createHash('sha256').update(input.xml, 'utf8').digest('hex');
  const actionKey = `personal-list:vndb:upload:${digest}`;
  const intent = { ...input.identity, path: PREVIEW_PATH, xml: input.xml };
  const prior = input.journal.action(actionKey);
  const sealed = (
    prior ? JSON.parse(prior.body_json) : input.journal.prepareAction(actionKey, intent, randomUUID())
  ) as typeof intent;
  const action = prior ?? input.journal.action(actionKey)!;
  // The same export in a reused journal must never be sent as a different person or to another destination.
  if (
    sealed.origin !== intent.origin ||
    sealed.path !== intent.path ||
    sealed.actor?.accountId !== intent.actor.accountId ||
    sealed.actor?.clientId !== intent.actor.clientId ||
    sealed.credential?.keyId !== intent.credential.keyId
  )
    return { state: 'unavailable', code: 'sealed-identity-changed' };
  if (action.state === 'refused') return { state: 'refused', code: action.error_code! };

  let response: PreviewResponse;
  try {
    response = await input.client.libraryImports.vndb.$preview.post(
      { xml: sealed.xml },
      {
        headers: { 'idempotency-key': JSON.stringify(action.idempotency_key) },
        fetch: { cache: 'no-store', redirect: 'manual' },
      },
    );
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof SyntaxError))
      throw error;
    return { state: 'unknown-delivery', code: 'transport-unavailable' };
  }

  if (response.error) {
    const code = `http-${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      input.journal.refuseAction(actionKey, code);
      return { state: 'refused', code };
    }
    return { state: 'unknown-delivery', code };
  }

  const uploaded = response.status === 200 ? preview(response.data) : null;
  if (!uploaded) return { state: 'unknown-delivery', code: 'invalid-response' };
  const receiptKey = `${actionKey}:response`;
  const receipt = input.journal.action(receiptKey);
  if (receipt) {
    const original = JSON.parse(receipt.body_json) as typeof uploaded;
    if (original.uploadId !== uploaded.uploadId || original.rows !== uploaded.rows)
      return { state: 'unknown-delivery', code: 'upload-response-changed' };
  } else {
    input.journal.prepareAction(receiptKey, uploaded, action.idempotency_key);
  }
  input.journal.acknowledgeAction(receiptKey, uploaded.uploadId);
  input.journal.acknowledgeAction(actionKey, uploaded.uploadId);
  return { state: 'uploaded', ...uploaded };
}

export type ShowcasePersonalListFailure = Exclude<ShowcasePersonalListUpload, { state: 'uploaded' }>;
export type ShowcasePersonalListRead<T> = { state: 'current'; value: T } | ShowcasePersonalListFailure;
export type ShowcasePersonalListAcknowledgement<T> = { state: 'acknowledged'; value: T } | ShowcasePersonalListFailure;

type Caller = {
  client: KernelClient;
  journal: ShowcaseJournal;
  identity: ShowcasePersonalListIdentity;
};
type ReviewCommand = { kind: 'review'; uploadId: string; body: ShowcasePersonalListReview };
type ApplyCommand = { kind: 'apply'; uploadId: string; body: ShowcasePersonalListSelection };
type CancelCommand = { kind: 'cancel'; uploadId: string };
type DeleteCommand = { kind: 'delete'; uploadId: string };
type Command = ReviewCommand | ApplyCommand | CancelCommand | DeleteCommand;
type SealedCommand = ShowcasePersonalListIdentity & { command: Command };

function sameIdentity(left: ShowcasePersonalListIdentity, right: ShowcasePersonalListIdentity): boolean {
  return (
    left.origin === right.origin &&
    left.actor.accountId === right.actor.accountId &&
    left.actor.clientId === right.actor.clientId &&
    left.credential.keyId === right.credential.keyId
  );
}

function httpFailure(status: number): ShowcasePersonalListFailure {
  return {
    state: status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'refused' : 'unknown-delivery',
    code: `http-${status}`,
  };
}

async function nativeRead<T>(
  send: () => Promise<{ status: number; error: unknown; data: T | null }>,
): Promise<ShowcasePersonalListRead<T>> {
  let response;
  try {
    response = await send();
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof SyntaxError))
      throw error;
    return { state: 'unknown-delivery', code: 'transport-unavailable' };
  }
  if (response.error) return httpFailure(response.status);
  if (response.status !== 200 || response.data === null) return { state: 'unknown-delivery', code: 'invalid-response' };
  return { state: 'current', value: response.data };
}

/** Read only the retained, currently authorized native preview; never reconstruct it from journal receipts. */
export function readShowcasePersonalList(input: {
  client: KernelClient;
  uploadId: string;
  offset?: number;
  language?: string;
}) {
  return nativeRead(() =>
    input.client.libraryImports.vndb({ uploadId: input.uploadId }).get({
      query: { offset: input.offset ?? 0 },
      headers: { 'accept-language': input.language ?? 'en' },
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
}

/** Independent owner return. One FULL page carries current state, Progress and counted own votes. */
export function readShowcasePersonalLibrary(input: { client: KernelClient; cursor?: string; language?: string }) {
  return nativeRead(() =>
    input.client.libraryEntries.get({
      query: {
        view: 'FULL',
        orderBy: 'lastActivity',
        direction: 'desc',
        limit: 8,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      headers: { 'accept-language': input.language ?? 'en' },
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
}

function sealCommand(input: Caller, intentId: string, command: Command) {
  const actionKey = `personal-list:vndb:command:${intentId}`;
  const prior = input.journal.action(actionKey);
  const sealed = (
    prior
      ? JSON.parse(prior.body_json)
      : input.journal.prepareAction(actionKey, { ...input.identity, command }, randomUUID())
  ) as SealedCommand;
  const action = prior ?? input.journal.action(actionKey)!;
  if (!sameIdentity(sealed, input.identity))
    return { failure: { state: 'unavailable', code: 'sealed-identity-changed' } as const };
  // An intent names one operation. Changed form fields cannot replace a pending command, even after reopen.
  if (sealed.command.kind !== command.kind)
    return { failure: { state: 'unavailable', code: 'sealed-operation-changed' } as const };
  if (action.state === 'refused') return { failure: { state: 'refused', code: action.error_code! } as const };
  return { actionKey, command: sealed.command, key: action.idempotency_key };
}

function refuseCommand(input: Caller, key: string, failure: ShowcasePersonalListFailure) {
  if (failure.state === 'refused') input.journal.refuseAction(key, failure.code);
  return failure;
}

/** A reviewed proposal is an acknowledgement, not evidence of an installed Library fact. */
export async function reviewShowcasePersonalList(
  input: Caller & { intentId: string; uploadId: string; body: ShowcasePersonalListReview },
): Promise<ShowcasePersonalListAcknowledgement<Reviewed>> {
  const sealed = sealCommand(input, input.intentId, { kind: 'review', uploadId: input.uploadId, body: input.body });
  if ('failure' in sealed) return sealed.failure;
  const command = sealed.command as ReviewCommand;
  const response = await nativeRead(() =>
    input.client.libraryImports.vndb({ uploadId: command.uploadId }).$review.post(command.body, {
      headers: { 'idempotency-key': JSON.stringify(sealed.key) },
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
  if (response.state !== 'current') return refuseCommand(input, sealed.actionKey, response);
  // Replaying still passes current native authorization. Only the review identity is immutable;
  // an apply receipt or subsequent current read may legitimately report later progress.
  const reviewId = 'reviewId' in response.value ? response.value.reviewId : undefined;
  const prior = input.journal.action(sealed.actionKey)!;
  if (prior.result_id && prior.result_id !== reviewId)
    return { state: 'unknown-delivery', code: 'review-response-changed' };
  input.journal.acknowledgeAction(sealed.actionKey, reviewId);
  return { state: 'acknowledged', value: response.value };
}

/** Explicit confirmation only; state/Progress review IDs and independent score review IDs stay separate. */
export async function applyShowcasePersonalList(
  input: Caller & { intentId: string; uploadId: string; body: ShowcasePersonalListSelection },
): Promise<ShowcasePersonalListAcknowledgement<Applied>> {
  const sealed = sealCommand(input, input.intentId, { kind: 'apply', uploadId: input.uploadId, body: input.body });
  if ('failure' in sealed) return sealed.failure;
  const command = sealed.command as ApplyCommand;
  const response = await nativeRead(() =>
    input.client.libraryImports.vndb({ uploadId: command.uploadId }).$apply.post(command.body, {
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
  if (response.state !== 'current') return refuseCommand(input, sealed.actionKey, response);
  const expected = new Set(
    command.body.rows.flatMap((row) => [
      ...(row.reviewId ? [`${row.ordinal}:state:${row.reviewId}`] : []),
      ...(row.scoreReviewId ? [`${row.ordinal}:score:${row.scoreReviewId}`] : []),
    ]),
  );
  const received = response.value.outcomes.map((row) =>
    'scoreReviewId' in row ? `${row.ordinal}:score:${row.scoreReviewId}` : `${row.ordinal}:state:${row.reviewId}`,
  );
  // A truncated or misaddressed HTTP response cannot acknowledge a different confirmation.
  if (
    response.value.uploadId !== command.uploadId ||
    new Set(received).size !== received.length ||
    received.some((key) => !expected.has(key)) ||
    (response.value.stopped === null && received.length !== expected.size)
  )
    return { state: 'unknown-delivery', code: 'apply-response-changed' };
  if (response.value.stopped === null) input.journal.acknowledgeAction(sealed.actionKey, command.uploadId);
  return { state: 'acknowledged', value: response.value };
}

/** Independent Progress page for one chosen work. Absence of a session is a current empty page, never a vote. */
export function readShowcasePersonalProgress(input: { client: KernelClient; subjectId: string; language?: string }) {
  return nativeRead(() =>
    input.client.progressSessions.get({
      query: { subjectId: input.subjectId, limit: 8 },
      headers: { 'accept-language': input.language ?? 'en' },
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
}

type Removed = NonNullable<Awaited<ReturnType<UploadedVndb['$cancel']['post']>>['data']>;

/** Cancel stops fresh admission; acknowledged Library, Progress and vote effects stay. */
export async function cancelShowcasePersonalList(
  input: Caller & { intentId: string; uploadId: string },
): Promise<ShowcasePersonalListAcknowledgement<Removed>> {
  const sealed = sealCommand(input, input.intentId, { kind: 'cancel', uploadId: input.uploadId });
  if ('failure' in sealed) return sealed.failure;
  const command = sealed.command as CancelCommand;
  const response = await nativeRead(() =>
    input.client.libraryImports.vndb({ uploadId: command.uploadId }).$cancel.post(
      {},
      {
        headers: { 'idempotency-key': JSON.stringify(sealed.key) },
        fetch: { cache: 'no-store', redirect: 'manual' },
      },
    ),
  );
  if (response.state !== 'current') return refuseCommand(input, sealed.actionKey, response);
  input.journal.acknowledgeAction(sealed.actionKey, command.uploadId);
  return { state: 'acknowledged', value: response.value };
}

/** Terminal deletion of the private upload. Native facts are not rolled back. */
export async function deleteShowcasePersonalList(
  input: Caller & { intentId: string; uploadId: string },
): Promise<ShowcasePersonalListAcknowledgement<Removed>> {
  const sealed = sealCommand(input, input.intentId, { kind: 'delete', uploadId: input.uploadId });
  if ('failure' in sealed) return sealed.failure;
  const command = sealed.command as DeleteCommand;
  const response = await nativeRead(() =>
    input.client.libraryImports.vndb({ uploadId: command.uploadId }).delete(undefined, {
      headers: { 'idempotency-key': JSON.stringify(sealed.key) },
      fetch: { cache: 'no-store', redirect: 'manual' },
    }),
  );
  if (response.state !== 'current') return refuseCommand(input, sealed.actionKey, response);
  input.journal.acknowledgeAction(sealed.actionKey, command.uploadId);
  return { state: 'acknowledged', value: response.value };
}

export type ShowcasePersonalLifecycleCommand =
  | { kind: 'preview'; xml: string }
  | { kind: 'page'; uploadId: string; offset?: number; language?: string }
  | { kind: 'review'; intentId: string; uploadId: string; body: ShowcasePersonalListReview }
  | { kind: 'apply'; intentId: string; uploadId: string; body: ShowcasePersonalListSelection }
  | { kind: 'library'; cursor?: string; language?: string }
  | { kind: 'progress'; subjectId: string; language?: string }
  | { kind: 'cancel'; intentId: string; uploadId: string }
  | { kind: 'delete'; intentId: string; uploadId: string };

type PageValue = NonNullable<Awaited<ReturnType<UploadedVndb['get']>>['data']>;
type LibraryValue = NonNullable<Awaited<ReturnType<KernelClient['libraryEntries']['get']>>['data']>;
type ProgressValue = NonNullable<Awaited<ReturnType<KernelClient['progressSessions']['get']>>['data']>;

export type ShowcasePersonalLifecycleResult =
  | { kind: 'preview'; value: ShowcasePersonalListUpload }
  | { kind: 'page'; value: ShowcasePersonalListRead<PageValue> }
  | { kind: 'review'; value: ShowcasePersonalListAcknowledgement<Reviewed> }
  | { kind: 'apply'; value: ShowcasePersonalListAcknowledgement<Applied> }
  | { kind: 'library'; value: ShowcasePersonalListRead<LibraryValue> }
  | { kind: 'progress'; value: ShowcasePersonalListRead<ProgressValue> }
  | { kind: 'cancel'; value: ShowcasePersonalListAcknowledgement<Removed> }
  | { kind: 'delete'; value: ShowcasePersonalListAcknowledgement<Removed> };

/**
 * One durable owner lifecycle: sealed preview, explicit match/review, confirmation, reopen, changed
 * reimport, cancel/delete, then independent current Library and Progress reads. Journal receipts never
 * substitute for a native current page.
 */
export async function runShowcasePersonalLifecycle(
  input: Caller & { commands: readonly ShowcasePersonalLifecycleCommand[] },
): Promise<ShowcasePersonalLifecycleResult[]> {
  const results: ShowcasePersonalLifecycleResult[] = [];
  for (const command of input.commands) {
    const caller = { client: input.client, journal: input.journal, identity: input.identity };
    if (command.kind === 'preview') {
      results.push({ kind: 'preview', value: await seedShowcasePersonalList({ ...caller, xml: command.xml }) });
      continue;
    }
    if (command.kind === 'page') {
      results.push({
        kind: 'page',
        value: await readShowcasePersonalList({
          client: input.client,
          uploadId: command.uploadId,
          ...(command.offset === undefined ? {} : { offset: command.offset }),
          ...(command.language === undefined ? {} : { language: command.language }),
        }),
      });
      continue;
    }
    if (command.kind === 'review') {
      results.push({
        kind: 'review',
        value: await reviewShowcasePersonalList({
          ...caller,
          intentId: command.intentId,
          uploadId: command.uploadId,
          body: command.body,
        }),
      });
      continue;
    }
    if (command.kind === 'apply') {
      results.push({
        kind: 'apply',
        value: await applyShowcasePersonalList({
          ...caller,
          intentId: command.intentId,
          uploadId: command.uploadId,
          body: command.body,
        }),
      });
      continue;
    }
    if (command.kind === 'library') {
      results.push({
        kind: 'library',
        value: await readShowcasePersonalLibrary({
          client: input.client,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.language === undefined ? {} : { language: command.language }),
        }),
      });
      continue;
    }
    if (command.kind === 'progress') {
      results.push({
        kind: 'progress',
        value: await readShowcasePersonalProgress({
          client: input.client,
          subjectId: command.subjectId,
          ...(command.language === undefined ? {} : { language: command.language }),
        }),
      });
      continue;
    }
    if (command.kind === 'cancel') {
      results.push({
        kind: 'cancel',
        value: await cancelShowcasePersonalList({ ...caller, intentId: command.intentId, uploadId: command.uploadId }),
      });
      continue;
    }
    results.push({
      kind: 'delete',
      value: await deleteShowcasePersonalList({ ...caller, intentId: command.intentId, uploadId: command.uploadId }),
    });
  }
  return results;
}
