import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../../kernel/client';
import { prepareSession, viewerCredential } from '../../../session/request';
import type { SessionEnv } from '../../../session/client';
import { contributionActionsInput } from './receiver';
import { validateContributionActionsResponse } from './response';

/** Private selected read only; native command owners retain every write. */
export const readContributionActions = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || !('accountId' in value) || typeof value.accountId !== 'string' ||
      !('view' in value) || (value.view !== 'posts' && value.view !== 'reviews' && value.view !== 'discussion') ||
      !('cursor' in value) || (value.cursor !== null && typeof value.cursor !== 'string')) throw new Error('Invalid contribution selection');
    const input = contributionActionsInput(value.accountId, value.view, value.cursor, value);
    if (!input) throw new Error('Invalid contribution selection');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const { accountId, references, ...body } = data;
    const result = await kernelClient().accounts({ id: accountId })['contribution-actions'].post(
      { ...body, references: [...references] },
      { ...(authorization ? { headers: { authorization } } : {}), fetch: { cache: 'no-store', signal: request.signal } },
    );
    if (result.status !== 200 || result.error || !result.data) throw new Error('Author contribution actions read failed');
    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    return {
      response: validateContributionActionsResponse(data, result.data),
      verification: {
        sitekey: config.TURNSTILE_SITE_KEY ?? '',
        scriptUrl: (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) || 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      },
    };
  });
