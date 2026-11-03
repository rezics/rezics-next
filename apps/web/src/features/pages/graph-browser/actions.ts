import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import {
  GRAPH_LIMIT,
  graphQueryOf,
  isExploreId,
  readSubjectGraphPage,
  type GraphRead,
  type GraphSelection,
  type GraphTruncation,
} from './index';

function address(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid graph address');
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !isExploreId(input.id) || typeof input.locale !== 'string' || input.locale.length > 35)
    throw new Error('Invalid graph address');
  const query = graphQueryOf({
    property: typeof input.property === 'string' || Array.isArray(input.property) ? (input.property as string | string[]) : undefined,
    direction: typeof input.direction === 'string' ? input.direction : undefined,
    depth: typeof input.depth === 'number' || typeof input.depth === 'string' ? input.depth : undefined,
  });
  const node = typeof input.node === 'string' && isExploreId(input.node) ? input.node : undefined;
  const edge =
    typeof input.edge === 'string' &&
    isExploreId(input.edge) &&
    typeof input.from === 'string' &&
    isExploreId(input.from) &&
    typeof input.to === 'string' &&
    isExploreId(input.to) &&
    typeof input.edgeProperty === 'string'
      ? {
          kind: 'edge' as const,
          statement: input.edge,
          from: input.from,
          to: input.to,
          property: input.edgeProperty,
        }
      : undefined;
  const expansion =
    input.expansion && typeof input.expansion === 'object'
      ? (input.expansion as GraphTruncation)
      : undefined;
  if (
    expansion &&
    (!isExploreId(expansion.node) ||
      typeof expansion.property !== 'string' ||
      (expansion.direction !== 'out' && expansion.direction !== 'in') ||
      typeof expansion.cursor !== 'string' ||
      expansion.cursor.length > 8192)
  )
    throw new Error('Invalid graph expansion');
  return {
    expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
    id: input.id,
    locale: input.locale,
    ...(query ?? {}),
    ...(node ? { node } : {}),
    ...(edge ? { edge } : {}),
    ...(expansion ? { expansion } : {}),
    session: typeof input.session === 'string' && input.session.length <= 16384 ? input.session : undefined,
  };
}

export async function exploreContext(locale: string, expectedReader: string | null) {
  setResponseHeader('cache-control', 'private, no-store');
  const [{ env }, { prepareSession, sessionSubject, viewerCredential }] = await Promise.all([
    import('cloudflare:workers'),
    import('../../../session/request'),
  ]);
  const request = getRequest();
  await prepareSession(request, env as import('../../../session/client').SessionEnv);
  const reader = sessionSubject(request);
  const authorization = viewerCredential(request) ?? undefined;
  if (expectedReader === null ? !!reader || !!authorization : reader !== expectedReader || !authorization) return null;
  const { kernelClient } = await import('../../../kernel/client');
  return { client: kernelClient(locale), authorization };
}

export const readSubjectGraphBrowser = createServerFn({ method: 'POST', strict: false })
  .validator(address)
  .handler(async ({ data }): Promise<GraphRead> => {
    const prepared = await exploreContext(data.locale, data.expectedReader);
    if (!prepared) return { ok: false, reason: 'denied' };
    const { fetchGuideRelease } = await import('../../catalogue/definition-guide');
    const headers = data.expectedReader && prepared.authorization ? { authorization: prepared.authorization } : {};
    let release;
    try {
      release = await fetchGuideRelease(prepared.client, undefined, headers);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const selection: GraphSelection | undefined = data.edge
      ? data.edge
      : data.node
        ? { kind: 'node', id: data.node }
        : undefined;
    return readSubjectGraphPage(
      prepared.client,
      prepared.authorization,
      release,
      data.id,
      data.locale,
      {
        property: data.property,
        direction: data.direction,
        depth: data.depth,
        selection,
        expansion: data.expansion,
        session: data.session,
      },
    );
  });

export const graphPageLimit = GRAPH_LIMIT;
