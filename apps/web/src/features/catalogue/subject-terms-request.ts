import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { MediaProblem } from '../../media/kernel';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { verifiedHandle } from '../../subject/load-subject';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';
import {
  isTermsCommand,
  type TermsCommand,
  type TermsFailure,
  type TermsPatch,
  type TermsRead,
  type TermsResult,
} from './subject-terms';

type Endpoint = ReturnType<KernelClient['subjects']>;
/** Declared producer port over Eden's existing runtime; no new client export or successful fallback. */
type DeclaredTermsEndpoint = Endpoint & {
  terms: {
    patch: (
      patch: TermsPatch,
      options: { headers: Record<string, string>; fetch: { redirect: 'manual' } },
    ) => Promise<{
      status: number;
      data: { subject: string; revision: number } | null;
      error: { value: unknown } | null;
      headers: HeadersInit;
    }>;
  };
};

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
      fetch: { redirect: 'manual' },
    });
    if (result.status === 404) return { state: 'concealed' };
    if (result.status === 401 || result.status === 403) return { state: 'denied' };
    if (
      result.status !== 200 ||
      !result.data ||
      result.data.subject.id !== id ||
      result.data.subject.context !== candidateContext
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
): Promise<TermsResult> {
  if (!isTermsCommand(command)) return { ok: false, reason: 'invalid' };
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'signed-out' };
    const endpoint = client.subjects({ id: command.id }) as DeclaredTermsEndpoint;
    const result = await endpoint.terms.patch(command.patch, {
      headers: {
        authorization,
        'if-match': command.etag,
        'idempotency-key': command.key,
        ...(command.session ? { 'rezics-session-token': command.session } : {}),
      },
      fetch: { redirect: 'manual' },
    });
    // A 404 on this not-yet-served port must not be represented as success or an empty subject.
    if (result.status !== 200 || !result.data)
      return result.status === 404 ? { ok: false, reason: 'unavailable' } : refusal(result.status, result.error?.value);
    const { subject: id, revision } = result.data;
    if (id !== command.id || !Number.isSafeInteger(revision) || revision < 1)
      return { ok: false, reason: 'unavailable' };
    const session = new Headers(result.headers).get('rezics-session-token') ?? command.session;
    return {
      ok: true,
      id,
      revision,
      ...(session ? { session } : {}),
      reader: await readSubjectTerms(client, id, locale, authorization),
    };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'unavailable' };
  }
}
