import { isView } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { relationLabels } from '../../subject/definitions';
import { loadSettingsPage, type SettingsPage } from '../../settings/preferences';
import { defaultReader, type Reader } from '../../subject/reader';
import { loadPublicAccountJourney, type AccountView } from '../../accounts/public-profile/page-read';
import { pageRelationProperties } from './subject';

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
    return { ...result, relations: await relationLabels(pageRelationProperties(result.overview), data.locale) };
  });

export type AgentReaderResult =
  | { kind: 'ready'; accountId: string; reader: Reader }
  | { kind: 'default'; accountId: string | null; reader: Reader };

function agentReaderResult(expectedReader: string, page: SettingsPage): AgentReaderResult {
  const accountId = page.signedIn ? (page.accountId ?? null) : null;
  if (!accountId || accountId !== expectedReader || !('preferences' in page))
    return { kind: 'default', accountId, reader: defaultReader };
  return {
    kind: 'ready',
    accountId,
    reader: { spoilerLevel: page.preferences.spoilerLevel, suitability: page.preferences.suitability },
  };
}

/** Reader preferences are loaded by the browser after hydration; they never affect public HTML. */
export const readAgentReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale, expectedReader } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    if (typeof expectedReader !== 'string' || expectedReader.length === 0 || expectedReader.length > 128)
      throw notFound();
    return { handle, locale, expectedReader };
  })
  .handler(async ({ data }): Promise<AgentReaderResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadSettingsPage(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>);
    return agentReaderResult(data.expectedReader, page);
  });
