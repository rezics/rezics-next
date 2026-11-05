import type { KernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, pickText } from '@rezics/composition';
import { MediaProblem } from '../../media/kernel';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { verifiedHandle } from '../../subject/load-subject';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';
import {
  isTermsCommand,
  type TermsCommand,
  type TermsFailure,
  type TermsPageAuthority,
  type TermsRead,
  type TermsResult,
  type TermsViewerState,
} from './subject-terms';

const termsOperation = { action: 'statement:propose', operation: 'subject.terms' } as const;

/** Observe only the mounted Terms operation on the exact Global authority resource. */
export async function readTermsPageAuthority(
  client: KernelClient,
  viewer: TermsViewerState,
  authorization?: string,
  signal?: AbortSignal,
): Promise<TermsPageAuthority> {
  signal?.throwIfAborted();
  if (viewer === 'signed-out') return { viewer, actions: { state: 'ready', actions: [] } };
  if (viewer !== 'signed-in' || !authorization) return { viewer: 'unavailable', actions: { state: 'unavailable' } };
  try {
    const result = await client.viewerActions.post(
      { resources: [{ type: 'semantic.context', id: PAGE_GLOBAL_CONTEXT }] },
      {
        headers: { authorization },
        fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
      },
    );
    signal?.throwIfAborted();
    if (result.status === 401) return { viewer: 'signed-out', actions: { state: 'ready', actions: [] } };
    if (result.error || result.status !== 200) return { viewer, actions: { state: 'unavailable' } };
    const resources = result.data?.resources;
    if (!Array.isArray(resources) || resources.length !== 1) return { viewer, actions: { state: 'unavailable' } };
    const resource = resources[0];
    if (
      !resource ||
      resource.type !== 'semantic.context' ||
      resource.id !== PAGE_GLOBAL_CONTEXT ||
      !('viewerActions' in resource) ||
      !Array.isArray(resource.viewerActions)
    )
      return { viewer, actions: { state: 'unavailable' } };
    const allowed = resource.viewerActions.some(
      (entry) =>
        entry?.action === termsOperation.action &&
        Array.isArray(entry.operations) &&
        entry.operations.includes(termsOperation.operation),
    );
    return {
      viewer,
      actions: {
        state: 'ready',
        actions: allowed ? [{ action: termsOperation.action, operations: [termsOperation.operation] }] : [],
      },
    };
  } catch {
    signal?.throwIfAborted();
    return { viewer, actions: { state: 'unavailable' } };
  }
}

function refusal(status: number, body?: unknown): TermsFailure {
  const code = body && typeof body === 'object' ? Reflect.get(body, 'code') : undefined;
  const detail: unknown = body && typeof body === 'object' ? Reflect.get(body, 'detail') : undefined;
  return {
    ok: false,
    reason:
      status === 401
        ? 'signed-out'
        : status === 403
          ? 'denied'
          : status === 412
            ? 'stale'
            : status === 422 && code === 'idempotency_conflict'
              ? 'conflict'
              : status === 400 || status === 422
                ? 'invalid'
                : status === 404
                  ? 'concealed'
                  : 'unavailable',
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}

/** Never follow a merge during an edit or switch the identity under a retained draft. */
export async function readSubjectTerms(
  client: KernelClient,
  id: string,
  locale: string,
  authorization?: string,
  session?: string,
): Promise<TermsRead> {
  try {
    const result = await client.subjects({ id }).get({
      headers: { ...(authorization ? { authorization } : {}), ...(session ? { 'rezics-session-token': session } : {}) },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.status === 404) return { state: 'concealed' };
    if (result.status === 401 || result.status === 403) return { state: 'denied' };
    if (
      result.status !== 200 ||
      !result.data ||
      result.data.subject.id !== id ||
      result.data.subject.context !== candidateContext ||
      !Number.isSafeInteger(result.data.subject.revision) ||
      result.data.subject.revision < 1
    )
      return { state: 'unavailable' };
    const headers = new Headers(result.headers);
    const etag = headers.get('etag');
    if (!etag || etag !== `"${result.data.subject.revision}"`) return { state: 'unavailable' };
    const { id: subjectId, type, revision, labels, descriptions, aliases } = result.data.subject;
    const handle = await verifiedHandle(client, result.data);
    const profileHref = handle ? accountHref(locale, handle) : undefined;
    const token = headers.get('rezics-session-token') ?? session;
    return {
      state: 'ready',
      snapshot: {
        subject: { id: subjectId, type, revision, labels, descriptions, aliases },
        etag,
        href: profileHref ?? subjectHref({ id, label: pickText(labels, locale).text }, locale).href,
        ...(profileHref ? { profileHref } : {}),
        ...(token ? { session: token } : {}),
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function patchSubjectTerms(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: TermsCommand,
  locale: string,
  expectedReader?: string,
): Promise<TermsResult> {
  if (!isTermsCommand(command)) return { ok: false, reason: 'invalid' };
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'signed-out' };
    if (expectedReader !== undefined && sessionSubject(request) !== expectedReader)
      return { ok: false, reason: 'denied' };
    const requestHeaders = {
      authorization,
      'if-match': command.etag,
      'idempotency-key': command.key,
      ...(command.session ? { 'rezics-session-token': command.session } : {}),
    };
    const result = await client.subjects({ id: command.id }).terms.patch(command.patch, {
      headers: requestHeaders,
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.status !== 200) return refusal(result.status, result.error?.value);
    if (!result.data || typeof result.data !== 'object' || Object.keys(result.data).length !== 2)
      return { ok: false, reason: 'unavailable' };
    const { subject: id, revision } = result.data;
    const headers = new Headers(result.headers);
    if (id !== command.id || !Number.isSafeInteger(revision) || revision < 1 || headers.get('etag') !== `"${revision}"`)
      return { ok: false, reason: 'unavailable' };
    const session = headers.get('rezics-session-token') ?? command.session;
    const reader = await readSubjectTerms(client, id, locale, authorization, session);
    return {
      ok: true,
      id,
      revision,
      ...(session ? { session } : {}),
      reader:
        reader.state === 'ready' && reader.snapshot.subject.revision < revision ? { state: 'unavailable' } : reader,
    };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'unavailable' };
  }
}
