import { isView, type View } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { readPageAuthors } from '../../identity/read';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SessionEnv } from '../../session/client';
import { relationLabels } from '../../subject/definitions';
import { loadReader } from '../../subject/load-reader';
import type { Reader } from '../../subject/reader';
import { agentPath, continueAgentList, loadAgentPage, agentTitle } from './agent';
import { accountOf } from './account-read';
import { pageContext, pageRelationProperties } from './subject';
import { isRecord } from './shared';
import { subjectTabs } from './views';

/** The page read of one agent, with the tab bar the overview's previews decide. */
export const readAgentPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale, view, cursor, search } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    if (view !== undefined && !isView(view)) throw notFound();
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw notFound();
    if (search !== undefined && (typeof search !== 'string' || search.length > 2048)) throw notFound();
    return {
      handle,
      locale,
      view: view as View | undefined,
      cursor: cursor as string | undefined,
      search: search as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    const client = kernelClient(data.locale);
    const view = data.view && data.view !== 'overview' ? data.view : undefined;
    const [result, overview] = await Promise.all([
      loadAgentPage(client, data.handle, view, data.locale),
      view ? loadAgentPage(client, data.handle, undefined, data.locale) : undefined,
    ]);
    // The same not-found page for every handle the kernel does not answer, whatever the reason.
    if (result.kind === 'missing' || overview?.kind === 'missing') {
      const lookup = await client.accounts.get({ query: { handle: data.handle } });
      const account = lookup.status === 200 ? lookup.data?.accounts?.[0] : undefined;
      const accountRecord = isRecord(account) ? (account as Record<string, unknown>) : undefined;
      const movedTo = typeof accountRecord?.movedTo === 'string' ? accountRecord.movedTo : undefined;
      if (typeof movedTo === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(movedTo)) {
        const query = data.search ? (data.search.startsWith('?') ? data.search : `?${data.search}`) : '';
        setResponseHeader('cache-control', 'public, max-age=300');
        return { kind: 'redirect' as const, redirectTo: `${agentPath(data.locale, movedTo, view)}${query}` };
      }
      setResponseHeader('cache-control', 'private, no-store');
      throw notFound();
    }
    const shown = overview ?? result;
    const operatorId = Object.entries(
      planReads(platformRegistry, shown.page.document as CompositionDocument, pageContext(shown.page)).reads,
    ).flatMap(([key, planned]) => {
      const read = shown.page.reads[key];
      return planned.kind === 'account' && read?.status === 200 ? [accountOf(read.body)?.operatorId] : [];
    })[0];
    const operators = operatorId ? await readPageAuthors(client, [operatorId]) : {};
    const identity = operatorId ? operators?.[operatorId] : undefined;
    const operator = identity
      ? {
          id: identity.id,
          handle: typeof identity.handle === 'string' ? identity.handle : null,
          displayName: typeof identity.displayName === 'string' ? identity.displayName : null,
        }
      : undefined;
    const page = view && data.cursor ? await continueAgentList(client, result.page, data.cursor) : result.page;
    setResponseHeader('cache-control', 'private, no-store');
    return {
      kind: 'page' as const,
      view: view ?? ('overview' as View),
      handle: data.handle,
      page,
      overview: shown.page,
      ...(operator ? { operator } : {}),
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
