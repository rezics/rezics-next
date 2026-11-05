import { expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { readSubjectChange, readSubjectChanges, type ChangesRead, type DetailRead } from './subject-changes';

function address(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid changes address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    input.id.length > 128 ||
    typeof input.locale !== 'string' ||
    input.locale.length > 35 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
  )
    throw new Error('Invalid changes address');
  return {
    expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
    id: input.id,
    locale: input.locale,
    cursor: input.cursor as string | undefined,
    session: input.session as string | undefined,
  };
}
async function context(locale: string, expectedReader: string | null) {
  setResponseHeader('cache-control', 'private, no-store');
  const [{ env }, { prepareSession, sessionSubject, viewerCredential }] = await Promise.all([
    import('cloudflare:workers'),
    import('../../session/request'),
  ]);
  const request = getRequest();
  await prepareSession(request, env as import('../../session/client').SessionEnv);
  const reader = sessionSubject(request);
  const authorization = viewerCredential(request) ?? undefined;
  // Absence is an explicit original anonymous reader, never permission to use new credentials.
  if (expectedReader === null ? !!reader || !!authorization : reader !== expectedReader || !authorization) return null;
  const { kernelClient } = await import('../../kernel/client');
  return { client: kernelClient(locale), authorization };
}

// POST uses the existing origin/CSRF middleware. Authorization never crosses the BFF.
export const loadSubjectChanges = createServerFn({ method: 'POST', strict: false })
  .validator(address)
  .handler(async ({ data }): Promise<ChangesRead> => {
    const prepared = await context(data.locale, data.expectedReader);
    if (!prepared) return { kind: 'denied', scope: 'subject' };
    const { client, authorization } = prepared;
    const { readRelease } = await import('../../subject/definitions');
    return readSubjectChanges(client, data.id, data.locale, {
      ...data,
      authorization,
      definitions: readRelease().catch(() => undefined),
    });
  });
export const loadSubjectChange = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    const input = address(value);
    const revision = (value as Record<string, unknown>).revision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('Invalid revision');
    return { ...input, revision: revision as number };
  })
  .handler(async ({ data }): Promise<DetailRead> => {
    const prepared = await context(data.locale, data.expectedReader);
    if (!prepared) return { kind: 'denied', scope: 'subject' };
    const { client, authorization } = prepared;
    const { readRelease } = await import('../../subject/definitions');
    return readSubjectChange(client, data.id, data.revision, {
      authorization,
      session: data.session,
      locale: data.locale,
      definitions: readRelease().catch(() => undefined),
    });
  });
