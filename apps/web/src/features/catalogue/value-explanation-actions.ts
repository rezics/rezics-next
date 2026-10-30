import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { readValueExplanation, valueRequest, type ValueRead } from './value-explanation';

export const loadValueExplanation = createServerFn({ method: 'POST', strict: false })
  .validator(valueRequest)
  .handler(async ({ data }): Promise<ValueRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { prepareSession, viewerCredential }, { kernelClient }, { loadReader }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../session/request'),
      import('../../kernel/client'),
      import('../../subject/load-reader'),
    ]);
    const request = getRequest();
    await prepareSession(request, env as Partial<import('../../session/client').SessionEnv>);
    const authorization = viewerCredential(request);
    const client = kernelClient(data.locale);
    return readValueExplanation(client, data, {
      ...(authorization ? { authorization } : {}),
      reader: loadReader(client, request, env as Partial<import('../../session/client').SessionEnv>),
    });
  });
