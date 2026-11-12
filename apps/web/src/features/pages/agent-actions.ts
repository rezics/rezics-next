import { isView } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { relationLabels } from '../../subject/definitions';
import { loadPublicAccountJourney, type AccountView } from '../../accounts/public-profile/page-read';
import { pageRelationProperties } from './subject-page-summary';

/** The page read of one agent, with the tab bar the overview's previews decide. */
export const readAgentPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale, view, cursor, search } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    if (view !== undefined && view !== 'realms' && !isView(view)) throw notFound();
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw notFound();
    if (search !== undefined && (typeof search !== 'string' || search.length > 16384)) throw notFound();
    return {
      handle,
      locale,
      view: view as AccountView | undefined,
      cursor: cursor as string | undefined,
      search: search as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadPublicAccountJourney(kernelClient(data.locale), data, getRequest().signal);
    if (result.kind === 'missing') throw notFound();
    if (result.kind !== 'page') return result;
    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    return {
      ...result,
      relations: await relationLabels(pageRelationProperties(result.overview), data.locale),
      verification: {
        sitekey: config.TURNSTILE_SITE_KEY ?? '',
        scriptUrl:
          (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
          'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      },
    };
  });
