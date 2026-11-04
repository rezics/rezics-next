import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { readSubjectRevisionDetail } from '../subject-changes-detail';
import type { DetailRead } from '../subject-changes';

/** Metadata only: no Subject body read, history listing, actor or candidate payload. */
export const loadCreditRevision = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid credit revision');
    const value = input as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      Number(value.revision) > 2147483647
    )
      throw new Error('Invalid credit revision');
    return {
      id: value.id,
      locale: value.locale,
      revision: value.revision as number,
      expectedReader: value.expectedReader === null ? null : expectedCandidateReader(value),
    };
  })
  .handler(async ({ data }): Promise<DetailRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { prepareSession, sessionSubject, viewerCredential }, { kernelClient }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../../session/request'),
      import('../../../kernel/client'),
    ]);
    const request = getRequest();
    await prepareSession(request, env as import('../../../session/client').SessionEnv);
    const reader = sessionSubject(request);
    const authorization = viewerCredential(request) ?? undefined;
    if (data.expectedReader === null ? !!reader || !!authorization : reader !== data.expectedReader || !authorization)
      return { kind: 'denied', scope: 'subject' };
    return readSubjectRevisionDetail(kernelClient(data.locale), { ...data, authorization });
  });
