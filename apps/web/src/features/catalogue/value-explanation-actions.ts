import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { readValueExplanation, valueRequest, type ValueRead } from './value-explanation';

export const loadValueExplanation = createServerFn({ method: 'POST', strict: false })
  .validator(valueRequest)
  .handler(async ({ data }): Promise<ValueRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { prepareSession, sessionSubject, viewerCredential }, { kernelClient }, { loadReader }] =
      await Promise.all([
        import('cloudflare:workers'),
        import('../../session/request'),
        import('../../kernel/client'),
        import('../../subject/load-reader'),
      ]);
    const request = getRequest();
    await prepareSession(request, env as Partial<import('../../session/client').SessionEnv>);
    const authorization = viewerCredential(request);
    const reader = sessionSubject(request);
    // The observation only refuses a changed reader; the prepared request still authenticates every read.
    if (
      ((data.cursor !== undefined || data.session !== undefined) && data.expectedReader === undefined) ||
      (data.expectedReader !== undefined &&
        (data.expectedReader === null ? !!reader || !!authorization : reader !== data.expectedReader || !authorization))
    )
      return { kind: 'denied' };
    const client = kernelClient(data.locale);
    return readValueExplanation(client, data, {
      ...(authorization ? { authorization } : {}),
      reader: loadReader(client, request, env as Partial<import('../../session/client').SessionEnv>),
    });
  });
