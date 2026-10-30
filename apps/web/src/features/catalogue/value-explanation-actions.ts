import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { readValueExplanation, valueRequest, type ValueRead } from './value-explanation';

export const loadValueExplanation = createServerFn({ method: 'POST', strict: false })
  .validator(valueRequest)
  .handler(async ({ data }): Promise<ValueRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { prepareSession, viewerCredential }, { kernelClient }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../session/request'),
      import('../../kernel/client'),
    ]);
    const request = getRequest();
    await prepareSession(request, env as Partial<import('../../session/client').SessionEnv>);
    const authorization = viewerCredential(request);
    return readValueExplanation(kernelClient(data.locale), data, authorization ? { authorization } : {});
  });
