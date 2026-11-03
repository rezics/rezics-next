import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE, setCookie } from '../session/cookies';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readSessionIdentity } from '../session/state';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { LibraryLabelSummary } from './subject-labels.ts';
import { libraryLabelNameIssue } from './subject-label-name';

export type LibraryLabel = LibraryLabelSummary;
export type LabelOperation = 'create' | 'rename' | 'delete' | 'restore';
export type LabelInput = {
  operation: LabelOperation;
  idempotencyKey: string;
  id?: string;
  name?: string;
  revision?: number;
};
export type LabelResult = { ok: boolean; reason?: string; detail?: string; revision?: number };
export type LabelFeedback = LabelResult & {
  operation?: LabelOperation;
  id?: string;
  name?: string;
  undo?: LibraryLabel;
  undoKey?: string;
  retry?: { idempotencyKey: string; revision?: number };
};
export type LabelsPage = {
  signedIn: boolean;
  state?: 'loaded' | 'closed' | 'denied' | 'preparing' | 'unavailable';
  query?: string;
  operations: string[];
  csrfToken: string;
  createKey: string;
  undoKey: string;
  labels: (LibraryLabel & { renameKey: string; deleteKey: string })[];
  next: string | null;
  feedback?: LabelFeedback;
};
const flashName = '__Host-rezics_label_result';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function labelProblem(value: unknown): { code?: string; detail?: string } {
  if (!value || typeof value !== 'object') return {};
  return {
    ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
    ...('detail' in value && typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}

export function validateLabelInput(value: unknown): LabelInput {
  return readLabelInput(value, true);
}

function readLabelInput(value: unknown, validateName: boolean): LabelInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid label input');
  const input = value as Record<string, unknown>;
  const operation = input.operation;
  if (
    !['create', 'rename', 'delete', 'restore'].includes(String(operation)) ||
    typeof input.idempotencyKey !== 'string' ||
    !uuid.test(input.idempotencyKey)
  )
    throw new Error('Invalid label input');
  if (
    operation !== 'create' &&
    (typeof input.id !== 'string' ||
      !/^[^/?:#\s]{1,128}$/.test(input.id) ||
      typeof input.revision !== 'number' ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1)
  )
    throw new Error('Invalid label revision');
  if (
    (operation === 'create' || operation === 'rename') &&
    (typeof input.name !== 'string' ||
      input.name.length > 1000 ||
      (validateName && libraryLabelNameIssue(input.name) !== undefined))
  )
    throw new Error('Invalid label name');
  return {
    operation: operation as LabelOperation,
    idempotencyKey: input.idempotencyKey,
    ...(typeof input.id === 'string' ? { id: input.id } : {}),
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(typeof input.revision === 'number' ? { revision: input.revision } : {}),
  };
}

function readFeedback(request: Request): LabelFeedback | undefined {
  try {
    const raw = cookie(request, flashName);
    if (!raw || raw.length > 3800) return undefined;
    const value = JSON.parse(decodeURIComponent(raw)) as { session?: string; feedback?: LabelFeedback };
    const feedback = value.feedback;
    if (value.session !== cookie(request, SESSION_COOKIE) || !feedback || typeof feedback.ok !== 'boolean')
      return undefined;
    for (const key of ['reason', 'detail', 'operation', 'id', 'name', 'undoKey'] as const) {
      if (feedback[key] !== undefined && typeof feedback[key] !== 'string') return undefined;
    }
    if (
      feedback.retry &&
      (!uuid.test(feedback.retry.idempotencyKey) ||
        (feedback.retry.revision !== undefined &&
          (!Number.isSafeInteger(feedback.retry.revision) || feedback.retry.revision < 1)))
    )
      return undefined;
    if (
      feedback.undo &&
      (typeof feedback.undo.id !== 'string' ||
        typeof feedback.undo.name !== 'string' ||
        !Number.isSafeInteger(feedback.undo.revision) ||
        feedback.undo.revision < 1)
    )
      return undefined;
    return feedback;
  } catch {
    return undefined;
  }
}
export const clearLabelFeedback = () => setCookie(flashName, '', 0);

/** One owner catalogue page, never a walk over subsequent pages. Exposure precedes the new read. */
export async function loadLabelsPage(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  cursor?: string,
  query?: string,
): Promise<LabelsPage> {
  const page: LabelsPage = {
    signedIn: false,
    ...(query === undefined ? {} : { query }),
    operations: [],
    csrfToken: '',
    createKey: crypto.randomUUID(),
    undoKey: crypto.randomUUID(),
    labels: [],
    next: null,
  };
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization || !sessionSubject(request)) return page;
    page.signedIn = true;
    page.csrfToken = (await readSessionIdentity(request, env)).csrfToken ?? '';
    const feedback = readFeedback(request);
    if (feedback) {
      page.feedback = feedback;
      if (!feedback.ok && feedback.operation === 'create' && feedback.retry)
        page.createKey = feedback.retry.idempotencyKey;
      if (feedback.undoKey) page.undoKey = feedback.undoKey;
    }
    const exposure = await client.platform.exposure.get({ headers: { authorization } });
    if (exposure.error || !exposure.data) throw new Error('Label exposure unavailable');
    page.operations = exposure.data.admitted;
    if (!page.operations.includes('library_label.list')) {
      page.state = 'closed';
      return page;
    }
    const result = await client.libraryLabels.get({
      query: { ...(cursor === undefined ? {} : { cursor }), ...(query === undefined ? {} : { q: query }), limit: 100 },
      headers: { authorization },
    });
    if (result.error || !result.data) {
      const code = labelProblem(result.error?.value).code;
      page.state = isPlatformClosedProblem(result.status, result.error?.value)
        ? 'closed'
        : result.status === 401 || result.status === 403 || result.status === 404
          ? 'denied'
          : code === 'index_not_ready' || code === 'semantic_not_ready'
            ? 'preparing'
            : 'unavailable';
      page.feedback = { ...page.feedback, ok: false, reason: code ?? 'unavailable' };
      return page;
    }
    page.state = 'loaded';
    page.labels = result.data.labels.map((label) => ({
      ...label,
      renameKey: crypto.randomUUID(),
      deleteKey: crypto.randomUUID(),
    }));
    page.next = result.data.next;
  } catch (error) {
    page.state = isPlatformClosedError(error) ? 'closed' : 'unavailable';
    page.feedback = { ...page.feedback, ok: false, reason: 'unavailable' };
  }
  return page;
}

/** One write with the submitted key and rendered revision; never infer a post-delete revision. */
export async function submitLabel(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  value: LabelInput,
): Promise<LabelResult> {
  let input: LabelInput;
  try {
    input = validateLabelInput(value);
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'unauthorized' };
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
    const labels = client.libraryLabels;
    const result =
      input.operation === 'create'
        ? await labels.post({ name: input.name! }, { headers })
        : input.operation === 'rename'
          ? await labels({ id: input.id! }).patch({ name: input.name!, revision: input.revision! }, { headers })
          : input.operation === 'delete'
            ? await labels({ id: input.id! }).delete(undefined, { query: { revision: input.revision! }, headers })
            : await labels({ id: input.id! }).$restore.post({ revision: input.revision! }, { headers });
    if (result.error) {
      const problem = labelProblem(result.error.value);
      return {
        ok: false,
        reason: problem.code ?? (result.error.status === 409 ? 'conflict' : 'unavailable'),
        ...(problem.detail ? { detail: problem.detail } : {}),
      };
    }
    if (!result.data) return { ok: false, reason: 'unavailable' };
    if (input.operation === 'delete') {
      const header = result.response?.headers.get('Library-Label-Revision');
      const revision = header && /^[1-9]\d*$/.test(header) ? Number(header) : NaN;
      if (!Number.isSafeInteger(revision)) return { ok: false, reason: 'unavailable' };
      return { ok: true, revision };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function labelFeedback(input: LabelInput, result: LabelResult): LabelFeedback {
  return {
    ...result,
    operation: input.operation,
    ...(!result.ok
      ? {
          retry: {
            idempotencyKey: input.idempotencyKey,
            ...(input.revision === undefined ? {} : { revision: input.revision }),
          },
        }
      : {}),
    ...(result.ok && input.operation === 'delete' ? { undoKey: crypto.randomUUID() } : {}),
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(result.ok && input.operation === 'delete' && result.revision !== undefined
      ? {
          undo: { id: input.id!, name: input.name ?? '', revision: result.revision },
        }
      : {}),
  };
}

/** Native HTML form fallback. The shared CSRF boundary validates the same bounded body before this handler. */
export async function handleLabelForm(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
): Promise<Response> {
  const url = new URL(request.url);
  let feedback: LabelFeedback;
  try {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
      throw new Error('Invalid form');
    const text = await request.clone().text();
    if (new TextEncoder().encode(text).length > 4096) throw new Error('Invalid form');
    const form = new URLSearchParams(text);
    for (const key of form.keys()) if (form.getAll(key).length !== 1) throw new Error('Duplicate form field');
    // Preserve bounded raw operands for field feedback when native-name validation refuses them.
    const input = readLabelInput(
      { ...Object.fromEntries(form), revision: Number(form.get('library_label_revision')) },
      false,
    );
    feedback = labelFeedback(input, await submitLabel(client, request, env, input));
    const capturedRevision = Number(form.get('undoRevision'));
    const captured =
      form.get('undoId') &&
      form.get('undoName') !== null &&
      Number.isSafeInteger(capturedRevision) &&
      capturedRevision > 0 &&
      uuid.test(form.get('undoKey') ?? '')
        ? {
            undo: { id: form.get('undoId')!, name: form.get('undoName')!, revision: capturedRevision },
            undoKey: form.get('undoKey')!,
          }
        : undefined;
    const previous = captured ?? readFeedback(request);
    const undoUnavailable =
      input.operation === 'restore' &&
      ['library_label_restore_stale', 'library_label_restore_expired', 'not_found'].includes(feedback.reason ?? '');
    if (!feedback.ok && input.operation === 'restore' && !undoUnavailable)
      feedback = {
        ...feedback,
        undo: { id: input.id!, name: input.name ?? '', revision: input.revision! },
        undoKey: input.idempotencyKey,
      };
    else if (
      !feedback.undo &&
      !undoUnavailable &&
      previous?.undo &&
      !(
        feedback.ok &&
        input.operation === 'restore' &&
        input.id === previous.undo.id &&
        input.revision === previous.undo.revision
      )
    )
      feedback = {
        ...feedback,
        undo: previous.undo,
        ...(previous.undoKey !== undefined ? { undoKey: previous.undoKey } : {}),
      };
  } catch {
    feedback = { ok: false, reason: 'invalid_request' };
  }
  // Keep private drafts and undo feedback out of URLs and bind the short-lived flash to this session.
  const flash = encodeURIComponent(JSON.stringify({ session: cookie(request, SESSION_COOKIE), feedback }));
  return new Response(null, {
    status: 303,
    headers: {
      location:
        url.pathname + (url.searchParams.has('q') ? `?${new URLSearchParams({ q: url.searchParams.get('q')! })}` : ''),
      'cache-control': 'private, no-store',
      'set-cookie': setCookie(flashName, flash.length <= 3800 ? flash : '', 60),
    },
  });
}
