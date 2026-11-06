import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../../session/client';
import { contributionActionsRequest, type ContributionActionsInput } from './receiver';
import type { AuthorContributionActionsResponse, AuthorContributionActionsWire } from './wire';

/**
 * The browser cannot reach the kernel directly, so the selected read runs here with the viewer's own credential.
 * The browser supplies only the admitted anonymous selection; the response stays private and no-store.
 */
export const readAuthorContributionActions = createServerFn({ method: 'POST' })
  .validator((value: unknown): ContributionActionsInput => {
    const request = contributionActionsRequest(value);
    if (!request) throw new Error('Invalid author contribution actions request');
    return request;
  })
  .handler(async ({ data }): Promise<AuthorContributionActionsResponse> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const { env } = await import('cloudflare:workers');
    const { prepareSession, viewerCredential } = await import('../../../session/request');
    const { kernelClient } = await import('../../../kernel/client');
    const { authorContributionActionsWire } = await import('./wire');
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw new Error('The author contribution actions read has no session credential');
    return authorContributionActionsWire(kernelClient(undefined, authorization)).read(data, request.signal);
  });

/** The mounted host's browser transport. Server failures reach the receiver as failed reads. */
export const contributionActionsWire: AuthorContributionActionsWire = {
  read: (input) => readAuthorContributionActions({ data: input }),
};
