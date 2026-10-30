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
import { agentPath, continueAgentList, loadAgentPage, agentTitle, formerHandleRedirect } from './agent';
import { accountOf, viewIsPublic } from './account-read';
import { pageContext, pageRelationProperties } from './subject';
import { subjectTabs } from './views';
import { keepSearch } from '../../subject/subject-href';

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
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const view = data.view && data.view !== 'overview' ? data.view : undefined;
    const [result, overview] = await Promise.all([
      loadAgentPage(client, data.handle, view, data.locale),
      view ? loadAgentPage(client, data.handle, undefined, data.locale) : undefined,
    ]);
    // The same not-found page for every handle the kernel does not answer, whatever the reason.
    if (result.kind === 'missing' || overview?.kind === 'missing') {
      const moved = await formerHandleRedirect(client, data.handle, data.locale, view, data.search);
      if (moved) return { kind: 'redirect' as const, redirectTo: moved.href };
      if (view && overview?.kind === 'page')
        return {
          kind: 'redirect' as const,
          redirectTo: keepSearch(agentPath(data.locale, overview.page.account.handle), data.search),
        };
      setResponseHeader('cache-control', 'private, no-store');
      throw notFound();
    }
    const shown = overview ?? result;
    // The native page may already resolve a former claim. Its embedded account read retains movedTo.
    const moved = Object.entries(
      planReads(platformRegistry, shown.page.document as CompositionDocument, pageContext(shown.page)).reads,
    )
      .flatMap(([key, read]) => {
        const response = shown.page.reads[key];
        return read.kind === 'account' && response?.status === 200 ? [accountOf(response.body)?.movedTo] : [];
      })
      .find((handle) => handle !== undefined);
    if (moved) {
      return { kind: 'redirect' as const, redirectTo: keepSearch(agentPath(data.locale, moved, view), data.search) };
    }
    const profiles = Object.entries(
      planReads(platformRegistry, shown.page.document as CompositionDocument, pageContext(shown.page)).reads,
    ).flatMap(([key, read]) => (read.kind === 'account' ? [accountOf(shown.page.reads[key]?.body)] : []));
    if (view && ((shown.page.views && !shown.page.views.includes(view)) || !viewIsPublic(profiles[0], view)))
      return {
        kind: 'redirect' as const,
        redirectTo: keepSearch(agentPath(data.locale, shown.page.account.handle), data.search),
      };
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
