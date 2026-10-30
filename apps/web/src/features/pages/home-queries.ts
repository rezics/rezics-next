import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { loadContinueState } from '../../library/continue-read';
import type { SessionEnv } from '../../session/client';
import { kernelClient } from '../../kernel/client';
import { publicRead } from '../../kernel/query';
import { validatePublicOrigin } from '../../shell/origin';
import { loadRoutePage } from './route';

const readHomePage = createServerFn({ method: 'GET' })
  .validator((locale: unknown) => {
    if (typeof locale !== 'string' || locale.length === 0 || locale.length > 35) throw new Error('Invalid locale');
    return locale;
  })
  .handler(async ({ data: locale }) => {
    const { env } = await import('cloudflare:workers');
    const page = await loadRoutePage(kernelClient(locale), '/', locale);
    if (page.kind === 'page') {
      const { nameSubjectTypes } = await import('../../subject/definitions');
      const subjects = Object.values(page.page.reads).flatMap((read) => {
        const body = read.body;
        if (!body || typeof body !== 'object' || !('subjects' in body) || !Array.isArray(body.subjects)) return [];
        return body.subjects.filter(
          (subject): subject is { type: string; typeLabel?: string } =>
            !!subject && typeof subject === 'object' && 'type' in subject && typeof subject.type === 'string',
        );
      });
      await nameSubjectTypes(subjects);
    }
    const origin = validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN);
    return { ...page, origin };
  });

export const homePageQuery = (locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['home-page', locale],
    queryFn: () => readHomePage({ data: locale }),
  });

/** Personal data has its own browser-only query and never enters the reusable public Home response. */
export const readHomeContinue = createServerFn({ method: 'GET' })
  .validator((locale: string) => {
    if (!locale || locale.length > 35) throw new Error('Invalid locale');
    return locale;
  })
  .handler(async ({ data: locale }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('Cache-Control', 'private, no-store');
    return loadContinueState(kernelClient(locale), getRequest(), env as Partial<SessionEnv>);
  });
