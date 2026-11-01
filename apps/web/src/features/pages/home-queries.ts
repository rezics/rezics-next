import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { kernelClient } from '../../kernel/client';
import { requestLanguages } from '../../kernel/languages';
import { readDiscovery, readDiscoveryKinds, type DiscoveryRequest } from '../../search/discovery';
import { homeFeedKind } from './home-feed-kinds';
import { publicRead } from '../../kernel/query';
import { validatePublicOrigin } from '../../shell/origin';
import { loadPublicHomeFeed, readHomeFeedPage, type FeedInput, type HomeFeedResult } from './home-feed-read';

function localeInput(locale: unknown): string {
  if (typeof locale !== 'string' || !locale || locale.length > 35) throw new Error('Invalid locale');
  return locale;
}
function feedInput(input: FeedInput & { locale: string }) {
  localeInput(input.locale);
  homeFeedKind(input.kind);
  if (
    !['home', 'following'].includes(input.stream) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 32768))
  )
    throw new Error('Invalid feed request');
  return input;
}

const readHomePage = createServerFn({ method: 'GET' })
  .validator(localeInput)
  .handler(async ({ data: locale }) => {
    const { env } = await import('cloudflare:workers');
    const feed = await loadPublicHomeFeed(kernelClient(locale));
    const origin = validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN);
    return { feed, origin };
  });

/** Only this anonymous result enters the reusable page query cache or hydration payload. */
export const homePageQuery = (locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['home-page', locale],
    queryFn: () => readHomePage({ data: locale }),
  });

export const readPublicHomePage = createServerFn({ method: 'GET' })
  .validator((input: { locale: string; cursor?: string; kind?: string }) => feedInput({ ...input, stream: 'home' }))
  .handler(({ data }) => loadPublicHomeFeed(kernelClient(data.locale), data.cursor, data.kind, getRequest().signal));

/** Private feed data lives in the mounted viewer's component, outside shared query/hydration caches. */
export const readPrivateHomePage = createServerFn({ method: 'GET' })
  .validator((input: FeedInput & { locale: string; viewer: string }) => {
    feedInput(input);
    if (typeof input.viewer !== 'string' || !input.viewer || input.viewer.length > 256)
      throw new Error('Invalid viewer');
    return input;
  })
  .handler(async ({ data }): Promise<HomeFeedResult> => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
      const authorization = viewerCredential(request);
      if (!authorization || sessionSubject(request) !== data.viewer)
        return { state: 'auth', code: 'authentication_required' };
      return readHomeFeedPage(
        kernelClient(data.locale),
        {
          stream: data.stream,
          ...(data.kind === undefined ? {} : { kind: data.kind }),
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        },
        authorization,
        request.signal,
      );
    } catch {
      return { state: 'unavailable', code: 'dependency_unavailable' };
    }
  });

/** Anonymous bounded registry metadata, read only when the Home control needs choices. No hits are retained. */
export const readHomeKinds = createServerFn({ method: 'GET' })
  .validator((input: { locale: string; cursor?: string }) => {
    localeInput(input.locale);
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 32768)
    )
      throw new Error('Invalid kind cursor');
    return input;
  })
  .handler(async ({ data }) => {
    const client = kernelClient(data.locale);
    const request: DiscoveryRequest = {
      representation: 'discovery-v1',
      languages: requestLanguages(data.locale),
      limit: 1,
      kindPage: { limit: 8 },
    };
    const send = (body: DiscoveryRequest) =>
      client.subjects.$search.post(body, {
        fetch: { signal: getRequest().signal, cache: 'no-store', redirect: 'manual' },
      });
    const result =
      data.cursor !== undefined
        ? await readDiscoveryKinds(request, data.cursor, send)
        : await readDiscovery(request, send).then(({ discovery }) =>
            discovery.status === 'ready' ? { status: 'ready' as const, kinds: discovery.page.kinds } : discovery,
          );
    if (result.status === 'ready') {
      try {
        for (const kind of result.kinds.values) homeFeedKind(kind.id);
      } catch {
        return { status: 'unavailable' as const };
      }
    }
    return result;
  });
