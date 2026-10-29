import { isView, type View } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { relationLabels } from '../../subject/definitions';
import { loadReader } from '../../subject/load-reader';
import type { Reader } from '../../subject/reader';
import { continueAgentList, loadAgentPage, agentTitle } from './agent';
import { pageRelationProperties } from './subject';
import { subjectTabs } from './views';

/** The page read of one agent, with the tab bar the overview's previews decide. */
export const readAgentPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale, view, cursor } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    if (view !== undefined && !isView(view)) throw notFound();
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw notFound();
    return { handle, locale, view: view as View | undefined, cursor: cursor as string | undefined };
  })
  .handler(async ({ data }) => {
    const client = kernelClient(data.locale);
    const view = data.view && data.view !== 'overview' ? data.view : undefined;
    const [result, overview] = await Promise.all([
      loadAgentPage(client, data.handle, view, data.locale),
      view ? loadAgentPage(client, data.handle, undefined, data.locale) : undefined,
    ]);
    // The same not-found page for every handle the kernel does not answer, whatever the reason.
    if (result.kind === 'missing' || overview?.kind === 'missing') throw notFound();
    const shown = overview ?? result;
    const page = view && data.cursor ? await continueAgentList(client, result.page, data.cursor) : result.page;
    return {
      view: view ?? ('overview' as View),
      handle: data.handle,
      page,
      overview: shown.page,
      ...(data.cursor ? { cursor: data.cursor } : {}),
      relations: await relationLabels(pageRelationProperties(shown.page), data.locale),
      tabs: subjectTabs(shown.page),
      title: agentTitle(shown.page),
    };
  });

/** Reader preferences are loaded by the browser after hydration; they never affect public HTML. */
export const readAgentReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    return { handle, locale };
  })
  .handler(async ({ data }): Promise<Reader> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadReader(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>);
  });
